const test = require('node:test');
const assert = require('node:assert/strict');

const { HelloFreshBrowser } = require('../dist/browser.js');

function createBrowser() {
  return new HelloFreshBrowser({
    baseUrl: 'https://www.hellofresh.nl',
    country: 'NL',
    locale: 'nl-NL',
    sessionPath: '/tmp/mcp-hellofresh-test-session.json',
    headless: true,
  });
}

test('recipeDetailsFromMenuRecipe parses API-backed recipe details', () => {
  const browser = createBrowser();
  const details = browser['recipeDetailsFromMenuRecipe'](
    'recipe-123',
    {
      id: 'recipe-123',
      name: 'Teriyaki Salmon',
      headline: 'Sweet soy glaze',
      nutrition: { calories: 650, carbohydrate: 42, protein: 31, fat: 24, sugar: 8, saturatedFat: 4 },
      ingredients: [
        { ingredient: { name: 'Salmon' }, amount: '2', unit: 'filets' },
        { ingredient: { name: 'Rice' }, amount: 150, unit: 'g' },
      ],
      steps: [{ text: 'Cook the rice.' }, { description: 'Bake the salmon.' }],
      allergens: [{ name: 'Fish' }, { label: 'Soy' }],
      utensils: [{ name: 'Pan' }],
      tags: [{ name: 'Family Friendly' }],
      totalTime: 'PT35M',
    },
    { servings: 2 }
  );

  assert.equal(details.name, 'Teriyaki Salmon');
  assert.equal(details.ingredients.length, 2);
  assert.deepEqual(details.instructions, ['Cook the rice.', 'Bake the salmon.']);
  assert.equal(details.nutrition.protein, 31);
  assert.deepEqual(details.allergens, ['Fish', 'Soy']);
  assert.deepEqual(details.utensils, ['Pan']);
});

test('normalizeDeliveryRecord handles nested delivery summaries', () => {
  const browser = createBrowser();
  const delivery = browser['normalizeDeliveryRecord']({
    delivery: {
      id: '2026-W23',
      expectedDeliveryDate: '2099-06-05',
      state: 'Scheduled',
      items: [
        { product: { recipe: { id: 'r1', name: 'Pasta' } }, quantity: 2 },
        { recipe: { id: 'r2', name: 'Soup' }, servings: 4 },
      ],
      allowedActions: { mealSwap: true },
    },
  });

  assert.equal(delivery.weekId, '2026-W23');
  assert.equal(delivery.deliveryDate, '2099-06-05');
  assert.equal(delivery.status, 'Scheduled');
  assert.deepEqual(delivery.meals, [
    { recipeId: 'r1', recipeName: 'Pasta', servings: 2 },
    { recipeId: 'r2', recipeName: 'Soup', servings: 4 },
  ]);
  assert.equal(delivery.canModify, true);
});

test('getDeliverySchedule surfaces API timeouts instead of scraping fallback', async () => {
  const browser = createBrowser();
  browser['isLoggedIn'] = true;
  let fallbackCalled = false;
  browser['getDeliveryRecords'] = async () => {
    throw new Error('HelloFresh API request timed out after 15000ms: /gw/api/customers/me/deliveries');
  };
  browser['scrapeDeliveryScheduleFromCurrentPage'] = async () => {
    fallbackCalled = true;
    return [];
  };

  await assert.rejects(() => browser.getDeliverySchedule(), /timed out after 15000ms/);
  assert.equal(fallbackCalled, false);
});

test('normalizeOrderRecord extracts meals, order-line dates, and currency', () => {
  const browser = createBrowser();
  const order = browser['normalizeOrderRecord']({
    incrementId: '1000123',
    lineItems: [
      { product: { recipe: { id: 'o1', name: 'Curry' } }, quantity: 2 },
    ],
    orderLines: [
      {
        deliveryDate: '2026-05-01T00:00:00+0200',
        paymentStatus: 'paid',
      },
    ],
    grandTotal: 2599,
    state: 'Delivered',
  });

  assert.deepEqual(order, {
    orderId: '1000123',
    deliveryDate: '2026-05-01T00:00:00+0200',
    meals: [{ recipeId: 'o1', recipeName: 'Curry', servings: 2 }],
    totalPrice: 25.99,
    status: 'Delivered',
    orderType: 'charge_only',
    itemNames: [],
  });
});

test('getPastOrders enriches meal-box orders from historical deliveries API and returns pagination metadata', async () => {
  const browser = createBrowser();
  browser['isLoggedIn'] = true;
  browser['getPrimarySubscriptionRecord'] = async () => ({ id: 'sub-1' });
  browser['apiGet'] = async (path) => {
    if (path.includes('/gw/my-deliveries/past-deliveries')) {
      return {
        weeks: [
          {
            week: '2026-W16',
            meals: [
              { id: 'r1', name: 'Pasta' },
              { id: 'r2', name: 'Soup' },
            ],
          },
        ],
        nextWeek: '2026-W15',
      };
    }
    if (path.includes('limit=1') && path.includes('offset=4')) {
      return { items: [{ id: 'later-order', orderLines: [{ deliveryDate: '2026-04-20T00:00:00+0200' }] }] };
    }
    return {
      items: [
        {
          id: 'meal-order',
          orderLines: [
            {
              deliveryDate: '2026-04-13T00:00:00+0200',
              productOrdered: { specs: { meals: 6, size: 2 } },
              sku: 'NL-CBU-6-2-0',
            },
          ],
          grandTotal: 73.98,
        },
        {
          id: 'charge-order',
          orderLines: [
            {
              deliveryDate: '2026-04-13T00:00:00+0200',
              productOrdered: { specs: { meals: 0, size: 0 } },
              sku: 'NL-CHARGE-0-0-0',
            },
          ],
          grandTotal: 5,
        },
      ],
    };
  };
  browser['getOrderDetailRecord'] = async () => {
    throw new Error('not found');
  };
  browser['scrapePastOrdersFromCurrentPage'] = async () => {
    throw new Error('browser fallback should not run');
  };

  const page = await browser.getPastOrders(2, 2);
  assert.equal(page.limit, 2);
  assert.equal(page.offset, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 4);
  assert.deepEqual(page.orders[0], {
    orderId: 'meal-order',
    deliveryDate: '2026-04-13T00:00:00+0200',
    meals: [
      { recipeId: 'r1', recipeName: 'Pasta', servings: 2 },
      { recipeId: 'r2', recipeName: 'Soup', servings: 2 },
    ],
    totalPrice: 73.98,
    status: 'Delivered',
    orderType: 'meal_box',
    itemNames: [],
  });
  assert.deepEqual(page.orders[1], {
    orderId: 'charge-order',
    deliveryDate: '2026-04-13T00:00:00+0200',
    meals: [],
    totalPrice: 5,
    status: 'Delivered',
    orderType: 'charge_only',
    itemNames: [],
  });
});

test('scrapePastOrdersFromCurrentPage reuses cached cards across consecutive pages', async () => {
  const browser = createBrowser();
  const cards = Array.from({ length: 6 }, (_, index) => ({
    weekId: `2026-W${16 + index}`,
    deliveryDate: `Delivered ${index}`,
    meals: [{ recipeId: `r${index}`, recipeName: `Meal ${index}`, servings: 0 }],
  }));
  const state = { url: '', loaded: 4, gotoCalls: 0, clickCalls: 0 };
  const showMoreButton = {
    first() {
      return this;
    },
    async isVisible() {
      return state.loaded < cards.length;
    },
    async click() {
      state.clickCalls += 1;
      state.loaded = Math.min(cards.length, state.loaded + 2);
    },
    async evaluate() {
      state.clickCalls += 1;
      state.loaded = Math.min(cards.length, state.loaded + 2);
    },
  };
  const countLocator = {
    async count() {
      return state.loaded;
    },
  };
  const page = {
    url() {
      return state.url;
    },
    async goto(url) {
      state.gotoCalls += 1;
      state.url = url;
      state.loaded = 4;
    },
    async waitForLoadState() {},
    async waitForFunction(_predicate, previousCount) {
      if (state.loaded <= previousCount) {
        throw new Error('expected more cards to load');
      }
    },
    locator(selector) {
      if (selector === '[data-test-id="past-deliveries-show-more-button"]') return showMoreButton;
      if (selector === '[id^="past-delivery-week-"]') return countLocator;
      return {
        first() {
          return this;
        },
        async isVisible() {
          return false;
        },
      };
    },
    async evaluate() {
      return cards.slice(0, state.loaded);
    },
  };
  browser['ensurePage'] = async () => page;
  browser['acceptCookiesIfPresent'] = async () => {};

  const firstPage = await browser['scrapePastOrdersFromCurrentPage'](3, 0);
  const secondPage = await browser['scrapePastOrdersFromCurrentPage'](3, 3);

  assert.deepEqual(firstPage.map((order) => order.weekId), ['2026-W16', '2026-W17', '2026-W18']);
  assert.deepEqual(secondPage.map((order) => order.weekId), ['2026-W19', '2026-W20', '2026-W21']);
  assert.equal(state.gotoCalls, 1);
  assert.equal(state.clickCalls, 1);
});

test('getPastOrders reports no next page when the probe is empty', async () => {
  const browser = createBrowser();
  browser['isLoggedIn'] = true;
  browser['apiGet'] = async (path) => {
    if (path.includes('limit=1') && path.includes('offset=1')) {
      return { items: [] };
    }
    return {
      items: [
        {
          id: 'meal-order',
          orderLines: [
            {
              deliveryDate: '2026-04-13T00:00:00+0200',
              productOrdered: { specs: { meals: 6, size: 2 } },
            },
          ],
          grandTotal: 73.98,
        },
      ],
    };
  };
  browser['getOrderDetailRecord'] = async () => {
    throw new Error('not found');
  };
  browser['scrapePastOrdersFromCurrentPage'] = async () => [
    {
      weekId: '2026-W16',
      deliveryDate: 'Bezorgd op ma. 13 apr',
      meals: [{ recipeId: 'r1', recipeName: 'Pasta', servings: 0 }],
    },
  ];

  const page = await browser.getPastOrders(1, 0);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextOffset, null);
});

test('getPastOrders throws clear partial-data error when meal-box orders still lack details', async () => {
  const browser = createBrowser();
  browser['isLoggedIn'] = true;
  browser['apiGet'] = async (path) => {
    if (path.includes('limit=1') && path.includes('offset=1')) {
      return { items: [] };
    }
    return {
      items: [
        {
          orderId: 'ord-1',
          orderLines: [
            {
              deliveryDate: '',
              productOrdered: { specs: { meals: 6, size: 2 } },
            },
          ],
        },
      ],
    };
  };
  browser['getOrderDetailRecord'] = async () => {
    throw new Error('not found');
  };
  browser['scrapePastOrdersFromCurrentPage'] = async () => [
    { weekId: '2026-W16', deliveryDate: '', meals: [] },
  ];

  await assert.rejects(() => browser.getPastOrders(1), /partial data/);
});

test('preferencesFromApiRecords derives normalized preferences', () => {
  const browser = createBrowser();
  const preferences = browser['preferencesFromApiRecords']([
    {
      preset: 'veggie',
      dietaryPreferences: [{ name: 'High Protein' }, { name: 'Family Friendly' }],
      customer: {
        allergens: [{ label: 'Gluten' }],
        cuisinePreferences: ['Italian', 'Thai'],
        calorieGoal: '1800',
      },
    },
  ]);

  assert.deepEqual(preferences, {
    dietaryPreferences: ['High Protein'],
    allergens: ['Gluten'],
    cuisinePreferences: ['Italian', 'Thai'],
    familyFriendly: true,
    vegetarian: true,
    calorieGoal: 1800,
  });
});

test('getPreferences throws contextual unsupported-data error when nothing is available', async () => {
  const browser = createBrowser();
  browser['isLoggedIn'] = true;
  browser['loadPreferenceApiRecords'] = async () => [];
  browser['scrapePreferencesFromPage'] = async () => null;

  await assert.rejects(() => browser.getPreferences(), /preferences are not exposed/);
});

test('updatePreferences reports missing controls instead of claiming success', async () => {
  const browser = createBrowser();
  browser['isLoggedIn'] = true;
  browser['ensurePage'] = async () => ({
    goto: async () => {},
    waitForLoadState: async () => {},
    locator: () => ({
      first() {
        return this;
      },
      isVisible: async () => false,
      isChecked: async () => false,
      click: async () => {},
    }),
  });

  const result = await browser.updatePreferences({ vegetarian: true });
  assert.equal(result.success, false);
  assert.match(result.message, /Could not find editable preference controls/);
});
