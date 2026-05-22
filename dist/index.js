#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const zod_1 = require("zod");
const browser_js_1 = require("./browser.js");
// ─── Schemas ──────────────────────────────────────────────────────────────────
const GetMenuSchema = zod_1.z.object({
    week_offset: zod_1.z
        .number()
        .int()
        .min(0)
        .max(4)
        .optional()
        .default(0)
        .describe("Week offset from current week (0 = current, 1 = next week, etc.)"),
});
const GetMenuForWeekSchema = zod_1.z.object({
    week_id: zod_1.z.string().describe("The week identifier (e.g. '2024-W01') for the delivery"),
});
const GetRecipeDetailsSchema = zod_1.z.object({
    recipe_id: zod_1.z.string().describe("The unique recipe identifier"),
});
const SelectMealsSchema = zod_1.z.object({
    week_id: zod_1.z
        .string()
        .describe("The week identifier (e.g. '2024-W01') for the delivery"),
    meals: zod_1.z
        .array(zod_1.z.object({
        recipe_id: zod_1.z.string().describe("Recipe ID to select"),
        servings: zod_1.z
            .number()
            .int()
            .min(1)
            .max(6)
            .optional()
            .describe("Number of servings (defaults to subscription default)"),
    }))
        .min(1)
        .describe("List of meals to select"),
});
const PreviewSelectMealsSchema = SelectMealsSchema;
const AddRecommendedExtrasSchema = zod_1.z.object({
    week_id: zod_1.z.string().describe("The week identifier (e.g. '2024-W01') for the delivery"),
});
const GetRecommendedExtrasSchema = zod_1.z.object({
    week_id: zod_1.z.string().describe("The week identifier (e.g. '2024-W01') for the delivery"),
    recipe_ids: zod_1.z
        .array(zod_1.z.string())
        .optional()
        .describe("Optional subset of currently selected meal recipe IDs to inspect for meal-specific recommended extras"),
});
const SetMealExtrasSchema = zod_1.z.object({
    week_id: zod_1.z.string().describe("The week identifier (e.g. '2024-W01') for the delivery"),
    extras: zod_1.z
        .array(zod_1.z.object({
        addon_index: zod_1.z.number().int().describe("The add-on index from get_recommended_extras"),
        meal_index: zod_1.z.number().int().optional().describe("The selected meal index this add-on should attach to"),
        meal_recipe_id: zod_1.z.string().optional().describe("Alternative to meal_index: selected meal recipe ID this add-on should attach to"),
        quantity: zod_1.z.number().int().min(1).max(10).optional().describe("Quantity to request for this add-on"),
    }))
        .min(1)
        .describe("Exact add-ons to apply to selected meals"),
});
const PreviewMealExtrasSchema = SetMealExtrasSchema;
const WeekPlanMealSchema = zod_1.z.object({
    recipe_id: zod_1.z.string().describe("Recipe ID to select"),
    servings: zod_1.z
        .number()
        .int()
        .min(1)
        .max(6)
        .optional()
        .describe("Number of servings (defaults to subscription default)"),
    extras: zod_1.z
        .array(zod_1.z.object({
        addon_index: zod_1.z.number().int().describe("Add-on index attached to this meal"),
        quantity: zod_1.z.number().int().min(1).max(10).optional().describe("Quantity to request for this add-on"),
    }))
        .optional()
        .describe("Optional meal-specific extras to attach to this selected meal"),
});
const ApplyWeekPlanSchema = zod_1.z.object({
    week_id: zod_1.z.string().describe("The week identifier (e.g. '2024-W01') for the delivery"),
    meals: zod_1.z.array(WeekPlanMealSchema).min(1).describe("Meals to select, each with optional meal-bound extras"),
});
const PreviewWeekPlanSchema = ApplyWeekPlanSchema;
const SkipWeekSchema = zod_1.z.object({
    week_id: zod_1.z.string().describe("The week identifier to skip (e.g. '2024-W01')"),
});
const ModifyDeliverySchema = zod_1.z.object({
    week_id: zod_1.z.string().describe("The week identifier for the delivery to modify"),
    new_date: zod_1.z
        .string()
        .describe("New delivery date in YYYY-MM-DD format"),
});
const UpdatePreferencesSchema = zod_1.z.object({
    vegetarian: zod_1.z
        .boolean()
        .optional()
        .describe("Enable/disable vegetarian meal preference"),
    family_friendly: zod_1.z
        .boolean()
        .optional()
        .describe("Enable/disable family-friendly meals"),
    dietary_preferences: zod_1.z
        .array(zod_1.z.string())
        .optional()
        .describe("List of dietary preferences to set"),
    allergens: zod_1.z
        .array(zod_1.z.string())
        .optional()
        .describe("List of allergens to avoid"),
    cuisine_preferences: zod_1.z
        .array(zod_1.z.string())
        .optional()
        .describe("Preferred cuisine types"),
});
const ModifySubscriptionSchema = zod_1.z.object({
    meals_per_week: zod_1.z
        .number()
        .int()
        .min(2)
        .max(5)
        .optional()
        .describe("Number of meals per week (2-5)"),
    servings_per_meal: zod_1.z
        .number()
        .int()
        .min(2)
        .max(4)
        .optional()
        .describe("Number of servings per meal (2-4)"),
    frequency: zod_1.z
        .enum(["weekly", "biweekly"])
        .optional()
        .describe("Delivery frequency"),
});
const GetPastOrdersSchema = zod_1.z.object({
    limit: zod_1.z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Maximum number of past orders to retrieve"),
});
const RateRecipeSchema = zod_1.z.object({
    recipe_id: zod_1.z.string().describe("The recipe ID to rate"),
    rating: zod_1.z
        .number()
        .int()
        .min(1)
        .max(5)
        .describe("Rating from 1 (poor) to 5 (excellent)"),
    comment: zod_1.z
        .string()
        .max(500)
        .optional()
        .describe("Optional written review/comment"),
});
// ─── Tool Definitions ─────────────────────────────────────────────────────────
const TOOLS = [
    {
        name: "get_menu",
        description: "Get the current week's available recipes/meals from HelloFresh. Optionally specify a week offset to see future menus.",
        inputSchema: {
            type: "object",
            properties: {
                week_offset: {
                    type: "number",
                    description: "Week offset from current week (0 = current, 1 = next week, etc.)",
                    default: 0,
                    minimum: 0,
                    maximum: 4,
                },
            },
        },
    },
    {
        name: "get_menu_for_week",
        description: "Get the available recipes/meals for a specific delivery week, including which meals are already selected.",
        inputSchema: {
            type: "object",
            properties: {
                week_id: {
                    type: "string",
                    description: "The week identifier (e.g. '2024-W01') for the delivery",
                },
            },
            required: ["week_id"],
        },
    },
    {
        name: "get_recipe_details",
        description: "Get full recipe information including ingredients, step-by-step instructions, nutrition facts, prep time, and allergen information.",
        inputSchema: {
            type: "object",
            properties: {
                recipe_id: {
                    type: "string",
                    description: "The unique recipe identifier",
                },
            },
            required: ["recipe_id"],
        },
    },
    {
        name: "preview_select_meals",
        description: "Preview selecting meals for a week without changing the account. Shows current selection, requested selection, added/removed meals, and premium charges.",
        inputSchema: {
            type: "object",
            properties: {
                week_id: {
                    type: "string",
                    description: "The week identifier (e.g. '2024-W01') for the delivery",
                },
                meals: {
                    type: "array",
                    description: "List of meals to preview selecting",
                    items: {
                        type: "object",
                        properties: {
                            recipe_id: { type: "string", description: "Recipe ID or menu index to select" },
                            servings: {
                                type: "number",
                                description: "Number of copies of this meal (optional)",
                                minimum: 1,
                                maximum: 6,
                            },
                        },
                        required: ["recipe_id"],
                    },
                    minItems: 1,
                },
            },
            required: ["week_id", "meals"],
        },
    },
    {
        name: "get_recommended_extras",
        description: "List meal-specific recommended extras/proteins for the currently selected meals in a week, or for a provided subset of selected meal recipe IDs.",
        inputSchema: {
            type: "object",
            properties: {
                week_id: {
                    type: "string",
                    description: "The week identifier (e.g. '2024-W01') for the delivery",
                },
                recipe_ids: {
                    type: "array",
                    description: "Optional subset of currently selected meal recipe IDs to inspect",
                    items: { type: "string" },
                },
            },
            required: ["week_id"],
        },
    },
    {
        name: "preview_meal_extras",
        description: "Preview explicit meal-specific extras for currently selected meals in a week without changing the account.",
        inputSchema: {
            type: "object",
            properties: {
                week_id: {
                    type: "string",
                    description: "The week identifier (e.g. '2024-W01') for the delivery",
                },
                extras: {
                    type: "array",
                    description: "Exact extras to preview attaching to selected meals",
                    items: {
                        type: "object",
                        properties: {
                            addon_index: { type: "number", description: "Add-on index from get_recommended_extras" },
                            meal_index: { type: "number", description: "Selected meal index this add-on should attach to" },
                            meal_recipe_id: { type: "string", description: "Alternative to meal_index: selected meal recipe ID" },
                            quantity: { type: "number", description: "Quantity to request", minimum: 1, maximum: 10 },
                        },
                        required: ["addon_index"],
                    },
                    minItems: 1,
                },
            },
            required: ["week_id", "extras"],
        },
    },
    {
        name: "select_meals",
        description: "Choose specific meals for an upcoming delivery week. You can select multiple recipes by their IDs.",
        inputSchema: {
            type: "object",
            properties: {
                week_id: {
                    type: "string",
                    description: "The week identifier (e.g. '2024-W01') for the delivery",
                },
                meals: {
                    type: "array",
                    description: "List of meals to select",
                    items: {
                        type: "object",
                        properties: {
                            recipe_id: { type: "string", description: "Recipe ID to select" },
                            servings: {
                                type: "number",
                                description: "Number of servings (optional)",
                                minimum: 1,
                                maximum: 6,
                            },
                        },
                        required: ["recipe_id"],
                    },
                    minItems: 1,
                },
            },
            required: ["week_id", "meals"],
        },
    },
    {
        name: "add_recommended_extras",
        description: "Add HelloFresh's meal-specific recommended extras/proteins for the currently selected meals in a week.",
        inputSchema: {
            type: "object",
            properties: {
                week_id: {
                    type: "string",
                    description: "The week identifier (e.g. '2024-W01') for the delivery",
                },
            },
            required: ["week_id"],
        },
    },
    {
        name: "set_meal_extras",
        description: "Apply explicit meal-specific extras to selected meals in a week using addon indexes from get_recommended_extras.",
        inputSchema: {
            type: "object",
            properties: {
                week_id: {
                    type: "string",
                    description: "The week identifier (e.g. '2024-W01') for the delivery",
                },
                extras: {
                    type: "array",
                    description: "Exact extras to attach to selected meals",
                    items: {
                        type: "object",
                        properties: {
                            addon_index: { type: "number", description: "Add-on index from get_recommended_extras" },
                            meal_index: { type: "number", description: "Selected meal index this add-on should attach to" },
                            meal_recipe_id: { type: "string", description: "Alternative to meal_index: selected meal recipe ID" },
                            quantity: { type: "number", description: "Quantity to request", minimum: 1, maximum: 10 },
                        },
                        required: ["addon_index"],
                    },
                    minItems: 1,
                },
            },
            required: ["week_id", "extras"],
        },
    },
    {
        name: "apply_week_plan",
        description: "Apply a complete stateless weekly plan: select meals with optional meal-bound extras.",
        inputSchema: {
            type: "object",
            properties: {
                week_id: {
                    type: "string",
                    description: "The week identifier (e.g. '2024-W01') for the delivery",
                },
                meals: {
                    type: "array",
                    description: "Meals to select, each with optional extras attached to that meal",
                    items: {
                        type: "object",
                        properties: {
                            recipe_id: { type: "string", description: "Recipe ID to select" },
                            servings: { type: "number", description: "Number of servings (optional)", minimum: 1, maximum: 6 },
                            extras: {
                                type: "array",
                                description: "Optional extras attached to this selected meal",
                                items: {
                                    type: "object",
                                    properties: {
                                        addon_index: { type: "number", description: "Add-on index attached to this meal" },
                                        quantity: { type: "number", description: "Quantity to request", minimum: 1, maximum: 10 },
                                    },
                                    required: ["addon_index"],
                                },
                            },
                        },
                        required: ["recipe_id"],
                    },
                    minItems: 1,
                },
            },
            required: ["week_id", "meals"],
        },
    },
    {
        name: "preview_week_plan",
        description: "Preview a complete stateless weekly plan: meal selection with optional meal-bound extras, without changing the account.",
        inputSchema: {
            type: "object",
            properties: {
                week_id: {
                    type: "string",
                    description: "The week identifier (e.g. '2024-W01') for the delivery",
                },
                meals: {
                    type: "array",
                    description: "Meals to select, each with optional extras attached to that meal",
                    items: {
                        type: "object",
                        properties: {
                            recipe_id: { type: "string", description: "Recipe ID to select" },
                            servings: { type: "number", description: "Number of servings (optional)", minimum: 1, maximum: 6 },
                            extras: {
                                type: "array",
                                description: "Optional extras attached to this selected meal",
                                items: {
                                    type: "object",
                                    properties: {
                                        addon_index: { type: "number", description: "Add-on index attached to this meal" },
                                        quantity: { type: "number", description: "Quantity to request", minimum: 1, maximum: 10 },
                                    },
                                    required: ["addon_index"],
                                },
                            },
                        },
                        required: ["recipe_id"],
                    },
                    minItems: 1,
                },
            },
            required: ["week_id", "meals"],
        },
    },
    {
        name: "skip_week",
        description: "Skip a delivery week so you won't receive or be charged for that week's box.",
        inputSchema: {
            type: "object",
            properties: {
                week_id: {
                    type: "string",
                    description: "The week identifier to skip (e.g. '2024-W01')",
                },
            },
            required: ["week_id"],
        },
    },
    {
        name: "get_delivery_schedule",
        description: "View all upcoming deliveries including dates, selected meals, and delivery status.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "modify_delivery",
        description: "Change the delivery date for an upcoming week's box.",
        inputSchema: {
            type: "object",
            properties: {
                week_id: {
                    type: "string",
                    description: "The week identifier for the delivery to modify",
                },
                new_date: {
                    type: "string",
                    description: "New delivery date in YYYY-MM-DD format",
                },
            },
            required: ["week_id", "new_date"],
        },
    },
    {
        name: "get_preferences",
        description: "Get your current dietary preferences including vegetarian settings, allergens, cuisine types, and family-friendly options.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "update_preferences",
        description: "Update your dietary and cuisine preferences on HelloFresh, such as vegetarian mode, allergen avoidance, and preferred cuisines.",
        inputSchema: {
            type: "object",
            properties: {
                vegetarian: {
                    type: "boolean",
                    description: "Enable/disable vegetarian meal preference",
                },
                family_friendly: {
                    type: "boolean",
                    description: "Enable/disable family-friendly meals",
                },
                dietary_preferences: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of dietary preferences to set",
                },
                allergens: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of allergens to avoid",
                },
                cuisine_preferences: {
                    type: "array",
                    items: { type: "string" },
                    description: "Preferred cuisine types",
                },
            },
        },
    },
    {
        name: "get_subscription",
        description: "View your current HelloFresh subscription plan details including meals per week, servings, price, and next delivery.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "modify_subscription",
        description: "Change your HelloFresh subscription plan size (meals per week or servings per meal) or delivery frequency.",
        inputSchema: {
            type: "object",
            properties: {
                meals_per_week: {
                    type: "number",
                    description: "Number of meals per week (2-5)",
                    minimum: 2,
                    maximum: 5,
                },
                servings_per_meal: {
                    type: "number",
                    description: "Number of servings per meal (2-4)",
                    minimum: 2,
                    maximum: 4,
                },
                frequency: {
                    type: "string",
                    enum: ["weekly", "biweekly"],
                    description: "Delivery frequency",
                },
            },
        },
    },
    {
        name: "get_past_orders",
        description: "View your HelloFresh order history including delivery dates, meals received, and order status.",
        inputSchema: {
            type: "object",
            properties: {
                limit: {
                    type: "number",
                    description: "Maximum number of past orders to retrieve (default: 10, max: 50)",
                    default: 10,
                    minimum: 1,
                    maximum: 50,
                },
            },
        },
    },
    {
        name: "rate_recipe",
        description: "Rate a HelloFresh recipe you've cooked on a scale of 1-5 stars, optionally including a written review.",
        inputSchema: {
            type: "object",
            properties: {
                recipe_id: {
                    type: "string",
                    description: "The recipe ID to rate",
                },
                rating: {
                    type: "number",
                    description: "Rating from 1 (poor) to 5 (excellent)",
                    minimum: 1,
                    maximum: 5,
                },
                comment: {
                    type: "string",
                    description: "Optional written review/comment (max 500 chars)",
                    maxLength: 500,
                },
            },
            required: ["recipe_id", "rating"],
        },
    },
];
const MUTATING_TOOL_NAMES = new Set([
    "select_meals",
    "add_recommended_extras",
    "set_meal_extras",
    "apply_week_plan",
    "skip_week",
    "modify_delivery",
    "update_preferences",
    "modify_subscription",
    "rate_recipe",
]);
// ─── Server Setup ─────────────────────────────────────────────────────────────
class HelloFreshMCPServer {
    server;
    hellofresh;
    initialized = false;
    readOnly;
    constructor() {
        this.server = new index_js_1.Server({ name: "@striderlabs/mcp-hellofresh", version: "1.0.0" }, { capabilities: { tools: {} } });
        this.hellofresh = new browser_js_1.HelloFreshBrowser({
            baseUrl: process.env.HELLOFRESH_BASE_URL,
            country: process.env.HELLOFRESH_COUNTRY,
            locale: process.env.HELLOFRESH_LOCALE,
            sessionPath: process.env.HELLOFRESH_SESSION_PATH,
            headless: process.env.HELLOFRESH_HEADLESS !== "false",
        });
        this.readOnly = process.env.HELLOFRESH_READ_ONLY !== "false";
        this.setupHandlers();
    }
    async ensureInitialized() {
        if (!this.initialized) {
            const email = process.env.HELLOFRESH_EMAIL;
            const password = process.env.HELLOFRESH_PASSWORD;
            if (!email || !password) {
                throw new Error("HELLOFRESH_EMAIL and HELLOFRESH_PASSWORD environment variables are required.");
            }
            const credentials = { email, password };
            await this.hellofresh.login(credentials);
            this.initialized = true;
        }
    }
    setupHandlers() {
        this.server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({
            tools: this.readOnly
                ? TOOLS.filter((tool) => !MUTATING_TOOL_NAMES.has(tool.name))
                : TOOLS,
        }));
        this.server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            try {
                if (this.readOnly && MUTATING_TOOL_NAMES.has(name)) {
                    throw new Error(`Tool ${name} is disabled because HELLOFRESH_READ_ONLY is enabled.`);
                }
                await this.ensureInitialized();
                return await this.handleTool(name, args ?? {});
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: "text", text: `Error: ${message}` }],
                    isError: true,
                };
            }
        });
    }
    async handleTool(name, args) {
        const text = (data) => ({
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        });
        switch (name) {
            case "get_menu": {
                const params = GetMenuSchema.parse(args);
                const menu = await this.hellofresh.getMenu(params.week_offset);
                return text({
                    week_offset: params.week_offset,
                    recipe_count: menu.length,
                    recipes: menu,
                });
            }
            case "get_recipe_details": {
                const params = GetRecipeDetailsSchema.parse(args);
                const details = await this.hellofresh.getRecipeDetails(params.recipe_id);
                return text(details);
            }
            case "get_menu_for_week": {
                const params = GetMenuForWeekSchema.parse(args);
                const menu = await this.hellofresh.getMenuForWeek(params.week_id);
                return text({
                    week_id: params.week_id,
                    recipe_count: menu.length,
                    recipes: menu,
                });
            }
            case "get_recommended_extras": {
                const params = GetRecommendedExtrasSchema.parse(args);
                const result = await this.hellofresh.getRecommendedExtras(params.week_id, params.recipe_ids);
                return text({
                    week_id: params.week_id,
                    meal_count: result.length,
                    recommendations: result,
                });
            }
            case "preview_meal_extras": {
                const params = PreviewMealExtrasSchema.parse(args);
                const result = await this.hellofresh.previewMealExtras(params.week_id, params.extras.map((extra) => ({
                    addonIndex: extra.addon_index,
                    mealIndex: extra.meal_index,
                    mealRecipeId: extra.meal_recipe_id,
                    quantity: extra.quantity,
                })));
                return text(result);
            }
            case "preview_select_meals": {
                const params = PreviewSelectMealsSchema.parse(args);
                const result = await this.hellofresh.previewSelectMeals(params.week_id, params.meals.map((m) => ({ recipeId: m.recipe_id, servings: m.servings })));
                return text(result);
            }
            case "select_meals": {
                const params = SelectMealsSchema.parse(args);
                const result = await this.hellofresh.selectMeals(params.week_id, params.meals.map((m) => ({ recipeId: m.recipe_id, servings: m.servings })));
                return text(result);
            }
            case "add_recommended_extras": {
                const params = AddRecommendedExtrasSchema.parse(args);
                const result = await this.hellofresh.addRecommendedExtras(params.week_id);
                return text(result);
            }
            case "set_meal_extras": {
                const params = SetMealExtrasSchema.parse(args);
                const result = await this.hellofresh.setMealExtras(params.week_id, params.extras.map((extra) => ({
                    addonIndex: extra.addon_index,
                    mealIndex: extra.meal_index,
                    mealRecipeId: extra.meal_recipe_id,
                    quantity: extra.quantity,
                })));
                return text(result);
            }
            case "preview_week_plan": {
                const params = PreviewWeekPlanSchema.parse(args);
                const result = await this.hellofresh.previewWeekPlan({
                    weekId: params.week_id,
                    meals: params.meals.map((meal) => ({
                        recipeId: meal.recipe_id,
                        servings: meal.servings,
                        extras: meal.extras?.map((extra) => ({
                            addonIndex: extra.addon_index,
                            quantity: extra.quantity,
                        })),
                    })),
                });
                return text(result);
            }
            case "apply_week_plan": {
                const params = ApplyWeekPlanSchema.parse(args);
                const result = await this.hellofresh.applyWeekPlan({
                    weekId: params.week_id,
                    meals: params.meals.map((meal) => ({
                        recipeId: meal.recipe_id,
                        servings: meal.servings,
                        extras: meal.extras?.map((extra) => ({
                            addonIndex: extra.addon_index,
                            quantity: extra.quantity,
                        })),
                    })),
                });
                return text(result);
            }
            case "skip_week": {
                const params = SkipWeekSchema.parse(args);
                const result = await this.hellofresh.skipWeek(params.week_id);
                return text(result);
            }
            case "get_delivery_schedule": {
                const schedule = await this.hellofresh.getDeliverySchedule();
                return text({
                    delivery_count: schedule.length,
                    deliveries: schedule,
                });
            }
            case "modify_delivery": {
                const params = ModifyDeliverySchema.parse(args);
                const result = await this.hellofresh.modifyDelivery(params.week_id, params.new_date);
                return text(result);
            }
            case "get_preferences": {
                const preferences = await this.hellofresh.getPreferences();
                return text(preferences);
            }
            case "update_preferences": {
                const params = UpdatePreferencesSchema.parse(args);
                const result = await this.hellofresh.updatePreferences({
                    vegetarian: params.vegetarian,
                    familyFriendly: params.family_friendly,
                    dietaryPreferences: params.dietary_preferences,
                    allergens: params.allergens,
                    cuisinePreferences: params.cuisine_preferences,
                });
                return text(result);
            }
            case "get_subscription": {
                const subscription = await this.hellofresh.getSubscription();
                return text(subscription);
            }
            case "modify_subscription": {
                const params = ModifySubscriptionSchema.parse(args);
                const result = await this.hellofresh.modifySubscription({
                    mealsPerWeek: params.meals_per_week,
                    servingsPerMeal: params.servings_per_meal,
                    frequency: params.frequency,
                });
                return text(result);
            }
            case "get_past_orders": {
                const params = GetPastOrdersSchema.parse(args);
                const orders = await this.hellofresh.getPastOrders(params.limit);
                return text({
                    order_count: orders.length,
                    orders,
                });
            }
            case "rate_recipe": {
                const params = RateRecipeSchema.parse(args);
                const result = await this.hellofresh.rateRecipe(params.recipe_id, params.rating, params.comment);
                return text(result);
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    async run() {
        const transport = new stdio_js_1.StdioServerTransport();
        await this.server.connect(transport);
        console.error("HelloFresh MCP server running on stdio");
        // Graceful shutdown
        process.on("SIGINT", async () => {
            await this.hellofresh.close();
            process.exit(0);
        });
        process.on("SIGTERM", async () => {
            await this.hellofresh.close();
            process.exit(0);
        });
    }
}
const server = new HelloFreshMCPServer();
server.run().catch(console.error);
//# sourceMappingURL=index.js.map