const test = require('node:test');
const assert = require('node:assert/strict');

const { compactWeekMenuResponse } = require('../dist/index.js');

test('compactWeekMenuResponse keeps only planning fields', () => {
  const result = compactWeekMenuResponse('2026-W23', [
    {
      id: 'recipe-1',
      name: 'Salmon Bowl',
      description: 'desc',
      prepTime: 10,
      cookTime: 20,
      totalTime: 30,
      difficulty: 'Easy',
      calories: 650,
      servings: 2,
      tags: ['High Protein'],
      menuIndex: 4,
      selected: true,
      nutritionPerServing: { kcal: 650, carbs_g: 42, protein_g: 31, fat_g: 24 },
      mealOptions: { recommendedExtrasHeadline: 'Try this', recommendedExtras: [], variations: [] },
      display: {
        title: 'Salmon Bowl',
        subtitle: 'desc',
        expectedCookingTimeMinutes: 30,
        categories: ['Family Friendly'],
        badges: ['High Protein'],
        nutritionPerServing: { kcal: 650, carbs_g: 42, protein_g: 31, fat_g: 24 },
        selected: true,
      },
    },
    {
      id: 'recipe-2',
      name: 'Veggie Pasta',
      description: 'desc',
      prepTime: 10,
      cookTime: 15,
      totalTime: 25,
      difficulty: 'Easy',
      calories: 500,
      servings: 2,
      tags: [],
      menuIndex: 5,
      selected: false,
      nutritionPerServing: undefined,
      display: {
        title: 'Veggie Pasta',
        subtitle: 'desc',
        expectedCookingTimeMinutes: 25,
        categories: [],
        badges: [],
        nutritionPerServing: undefined,
        selected: false,
      },
    },
  ]);

  assert.equal(result.week_id, '2026-W23');
  assert.equal(result.recipe_count, 2);
  assert.deepEqual(Object.keys(result.recipes[0]).sort(), [
    'cooking_time_minutes',
    'menu_index',
    'name',
    'nutrition_per_serving',
    'recipe_id',
    'selected',
    'servings',
  ]);
  assert.deepEqual(result.recipes[0].nutrition_per_serving, {
    kcal: 650,
    carbs_g: 42,
    protein_g: 31,
    fat_g: 24,
  });
  assert.equal(result.recipes[1].nutrition_per_serving, null);
});
