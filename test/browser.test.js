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

test('normalizeOrderRecord extracts meals, dates, and currency', () => {
  const browser = createBrowser();
  const order = browser['normalizeOrderRecord']({
    incrementId: '1000123',
    delivery_date: '2026-05-01',
    lineItems: [
      { product: { recipe: { id: 'o1', name: 'Curry' } }, quantity: 2 },
    ],
    grandTotal: 2599,
    state: 'Delivered',
  });

  assert.deepEqual(order, {
    orderId: '1000123',
    deliveryDate: '2026-05-01',
    meals: [{ recipeId: 'o1', recipeName: 'Curry', servings: 2 }],
    totalPrice: 25.99,
    status: 'Delivered',
  });
});

test('getPastOrders throws clear partial-data error when neither API nor fallback has details', async () => {
  const browser = createBrowser();
  browser['isLoggedIn'] = true;
  browser['apiGet'] = async () => ({
    items: [{ orderId: 'ord-1', deliveryDate: '', meals: [] }],
  });
  browser['getOrderDetailRecord'] = async () => {
    throw new Error('not found');
  };
  browser['scrapePastOrdersFromCurrentPage'] = async () => [
    { orderId: 'ord-1', deliveryDate: '', meals: [], totalPrice: 0, status: 'Delivered' },
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
