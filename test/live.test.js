const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const workspaceTmpDir = join(process.cwd(), '.tmp');
mkdirSync(workspaceTmpDir, { recursive: true });
process.env.TMPDIR = process.env.TMPDIR || workspaceTmpDir;
const { HelloFreshBrowser } = require('../dist/browser.js');
const { HelloFreshMCPServer } = require('../dist/index.js');
const missingEnv = ['HELLOFRESH_EMAIL', 'HELLOFRESH_PASSWORD', 'HELLOFRESH_BASE_URL', 'HELLOFRESH_COUNTRY']
  .filter((key) => !process.env[key]);
const liveSkip = missingEnv.length > 0
  ? `Missing live test env: ${missingEnv.join(', ')}`
  : false;
const sessionPath = process.env.HELLOFRESH_SESSION_PATH || join(tmpdir(), `mcp-hellofresh-live-${process.pid}.json`);
const browserOptions = {
  baseUrl: process.env.HELLOFRESH_BASE_URL,
  country: process.env.HELLOFRESH_COUNTRY,
  locale: process.env.HELLOFRESH_LOCALE,
  sessionPath,
  headless: process.env.HELLOFRESH_HEADLESS !== 'false',
};
const credentials = {
  email: process.env.HELLOFRESH_EMAIL,
  password: process.env.HELLOFRESH_PASSWORD,
};

let liveWeekId = '';
let liveRecipeId = '';

function createBrowser() {
  return new HelloFreshBrowser(browserOptions);
}

async function withBrowser(fn) {
  const browser = createBrowser();
  try {
    return await fn(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function callServerTool(server, name, args = {}) {
  const response = await server.handleTool(name, args);
  const text = response.content[0]?.text ?? '';
  return { text, data: JSON.parse(text) };
}

const bootstrapPromise = liveSkip
  ? Promise.resolve()
  : withBrowser(async (browser) => {
      await browser.login(credentials);
      const subscription = await browser.getPrimarySubscriptionRecord();
      liveWeekId = await browser.getMenuWeek(subscription, 0);
      const menu = await browser.getMenuForWeek(liveWeekId);
      assert.ok(menu.length > 0, 'expected at least one live menu recipe');
      liveRecipeId = menu[0].id;
    });

test('live stored-session login resolves recipe details without page crash', {
  skip: liveSkip,
  timeout: 180000,
}, async () => {
  await bootstrapPromise;
  assert.ok(liveRecipeId, 'live bootstrap did not populate a recipe id');

  await withBrowser(async (browser) => {
    await browser.login(credentials);
    assert.equal(browser.page, null, 'stored session login should still be API-only before ensurePage');
    const details = await browser.getRecipeDetails(liveRecipeId);
    assert.equal(details.id, liveRecipeId);
    assert.ok(details.name, 'expected recipe details name');
    assert.ok(
      details.nutrition.calories > 0 || details.ingredients.length > 0 || details.instructions.length > 0,
      'expected live recipe details to expose nutrition or content'
    );
  });
});

test('live read-only tool handlers return compact and normalized responses', {
  skip: liveSkip,
  timeout: 180000,
}, async () => {
  await bootstrapPromise;
  assert.ok(liveWeekId, 'live bootstrap did not populate a week id');

  const previousReadOnly = process.env.HELLOFRESH_READ_ONLY;
  process.env.HELLOFRESH_READ_ONLY = 'true';
  const server = new HelloFreshMCPServer();

  try {
    assert.equal(server.readOnly, true, 'expected server to run in read-only mode');
    await server.ensureInitialized();

    const menu = await callServerTool(server, 'get_menu_for_week', { week_id: liveWeekId });
    assert.ok(menu.data.recipe_count > 0, 'expected live compact menu recipes');
    assert.equal(menu.data.recipe_count, menu.data.recipes.length);
    assert.ok(Buffer.byteLength(menu.text, 'utf8') < 60000, 'compact live menu payload unexpectedly large');
    for (const recipe of menu.data.recipes) {
      assert.ok(Object.prototype.hasOwnProperty.call(recipe, 'nutrition_per_serving'));
      assert.equal(Object.prototype.hasOwnProperty.call(recipe, 'display'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(recipe, 'mealOptions'), false);
    }

    const details = await callServerTool(server, 'get_recipe_details', { recipe_id: menu.data.recipes[0].recipe_id });
    assert.ok(details.data.name, 'expected live recipe details name');
    assert.ok(
      details.data.nutrition.calories > 0 || details.data.ingredients.length > 0 || details.data.instructions.length > 0,
      'expected live recipe details to expose nutrition or content'
    );

    const delivery = await callServerTool(server, 'get_delivery_schedule');
    assert.ok(Array.isArray(delivery.data.deliveries));
    if (delivery.data.deliveries.length > 0) {
      const first = delivery.data.deliveries[0];
      assert.equal(typeof first.weekId, 'string');
      assert.equal(typeof first.status, 'string');
      assert.ok(Array.isArray(first.meals));
    }

    const firstPage = await callServerTool(server, 'get_past_orders', { limit: 3, offset: 0 });
    assert.equal(firstPage.data.order_count, firstPage.data.orders.length);
    assert.equal(firstPage.data.limit, 3);
    assert.equal(firstPage.data.offset, 0);
    assert.equal(typeof firstPage.data.has_more, 'boolean');
    assert.equal(firstPage.data.next_offset, firstPage.data.has_more ? 3 : null);
    assert.ok(
      firstPage.data.orders.every((order) => order.deliveryDate),
      'live orders should include delivery dates'
    );
    assert.ok(
      firstPage.data.orders.some((order) => order.meals.length > 0),
      'live meal-box orders should include historical meals'
    );

    if (firstPage.data.has_more) {
      const secondPage = await callServerTool(server, 'get_past_orders', {
        limit: 3,
        offset: firstPage.data.next_offset,
      });
      assert.equal(secondPage.data.offset, firstPage.data.next_offset);
      assert.notDeepEqual(
        secondPage.data.orders.map((order) => order.orderId),
        firstPage.data.orders.map((order) => order.orderId),
        'paginated historical orders should advance to a different slice'
      );
    }

    try {
      const preferences = await callServerTool(server, 'get_preferences');
      assert.equal(typeof preferences.data.vegetarian, 'boolean');
      assert.equal(typeof preferences.data.familyFriendly, 'boolean');
      assert.ok(Array.isArray(preferences.data.dietaryPreferences));
    } catch (error) {
      assert.match(error.message, /preferences are not exposed|API lookup failed/i);
    }
  } finally {
    process.env.HELLOFRESH_READ_ONLY = previousReadOnly;
    await server.hellofresh.close().catch(() => {});
  }
});
