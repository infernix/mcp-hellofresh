export interface HelloFreshCredentials {
    email: string;
    password: string;
}
export interface Recipe {
    id: string;
    name: string;
    description: string;
    imageUrl?: string;
    prepTime: number;
    cookTime: number;
    totalTime: number;
    difficulty: string;
    calories: number;
    servings: number;
    tags: string[];
    cuisineType?: string;
    isVegetarian?: boolean;
    isFamily?: boolean;
}
export interface RecipeDetails extends Recipe {
    ingredients: Ingredient[];
    instructions: string[];
    nutrition: NutritionInfo;
    allergens: string[];
    utensils: string[];
}
export interface Ingredient {
    name: string;
    amount: string;
    unit: string;
}
export interface NutritionInfo {
    calories: number;
    fat: number;
    saturatedFat: number;
    carbohydrates: number;
    sugar: number;
    protein: number;
    fiber: number;
    sodium: number;
}
export interface DeliveryInfo {
    weekId: string;
    deliveryDate: string;
    status: string;
    meals: SelectedMeal[];
    canModify: boolean;
}
export interface SelectedMeal {
    recipeId: string;
    recipeName: string;
    servings: number;
}
export interface Preferences {
    dietaryPreferences: string[];
    allergens: string[];
    cuisinePreferences: string[];
    familyFriendly: boolean;
    vegetarian: boolean;
    calorieGoal?: number;
}
export interface Subscription {
    planId: string;
    mealsPerWeek: number;
    servingsPerMeal: number;
    frequency: string;
    pricePerServing: number;
    nextDeliveryDate: string;
    status: string;
}
export interface Order {
    orderId: string;
    deliveryDate: string;
    meals: SelectedMeal[];
    totalPrice: number;
    status: string;
}
export declare class HelloFreshBrowser {
    private browser;
    private context;
    private page;
    private isLoggedIn;
    private readonly baseUrl;
    init(): Promise<void>;
    login(credentials: HelloFreshCredentials): Promise<void>;
    private ensureLoggedIn;
    getMenu(weekOffset?: number): Promise<Recipe[]>;
    private parseApiRecipes;
    getRecipeDetails(recipeId: string): Promise<RecipeDetails>;
    getDeliverySchedule(): Promise<DeliveryInfo[]>;
    selectMeals(weekId: string, mealSelections: {
        recipeId: string;
        servings?: number;
    }[]): Promise<{
        success: boolean;
        message: string;
    }>;
    skipWeek(weekId: string): Promise<{
        success: boolean;
        message: string;
    }>;
    modifyDelivery(weekId: string, newDate: string): Promise<{
        success: boolean;
        message: string;
    }>;
    getPreferences(): Promise<Preferences>;
    updatePreferences(preferences: Partial<Preferences>): Promise<{
        success: boolean;
        message: string;
    }>;
    getSubscription(): Promise<Subscription>;
    modifySubscription(changes: Partial<{
        mealsPerWeek: number;
        servingsPerMeal: number;
        frequency: string;
    }>): Promise<{
        success: boolean;
        message: string;
    }>;
    getPastOrders(limit?: number): Promise<Order[]>;
    rateRecipe(recipeId: string, rating: number, comment?: string): Promise<{
        success: boolean;
        message: string;
    }>;
    close(): Promise<void>;
}
//# sourceMappingURL=browser.d.ts.map