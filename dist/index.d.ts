#!/usr/bin/env node
import { type WeekMenuMeal } from "./browser.js";
export declare function compactWeekMenuResponse(weekId: string, menu: WeekMenuMeal[]): {
    week_id: string;
    recipe_count: number;
    recipes: Array<{
        recipe_id: string;
        menu_index: number;
        name: string;
        nutrition_per_serving: WeekMenuMeal["nutritionPerServing"] | null;
        selected: boolean;
        servings: number;
        cooking_time_minutes: number;
    }>;
};
export declare class HelloFreshMCPServer {
    private server;
    private hellofresh;
    private initialized;
    private readonly readOnly;
    constructor();
    private ensureInitialized;
    private setupHandlers;
    private handleTool;
    run(): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map