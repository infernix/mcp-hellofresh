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
export interface MealSelectionInput {
    recipeId: string;
    servings?: number;
}
export interface MealSelectionPreview {
    weekId: string;
    canSelect: boolean;
    reason?: string;
    expectedMealCount: number;
    requestedMealCount: number;
    currentMeals: SelectedMeal[];
    requestedMeals: SelectedMeal[];
    addedMeals: SelectedMeal[];
    removedMeals: SelectedMeal[];
    price?: {
        subtotal: number;
        shipping: number;
        premiumCharges: number;
        grandTotal: number;
        charges: Array<{
            recipeId: string;
            amount: number;
            reason: string;
        }>;
    };
}
export interface RecommendedExtraSelection {
    mealIndex: number;
    mealName: string;
    addonIndex: number;
    addonName: string;
    price: number;
}
export interface RecommendedExtraOption {
    mealIndex: number;
    mealRecipeId: string;
    mealName: string;
    headline: string;
    options: Array<{
        addonIndex: number;
        addonName: string;
        price: number;
    }>;
}
export interface MealExtraInput {
    addonIndex: number;
    mealIndex?: number;
    mealRecipeId?: string;
    quantity?: number;
}
export interface MealExtrasPreview {
    weekId: string;
    canApply: boolean;
    selectedMeals: SelectedMeal[];
    requestedExtras: Array<RecommendedExtraSelection & {
        quantity: number;
    }>;
    totalExtraCost: number;
}
export interface WeekPlanPreview {
    weekId: string;
    canApply: boolean;
    mealSelection: MealSelectionPreview;
    explicitExtras?: MealExtrasPreview;
    totalExtraCost: number;
}
export interface WeekMenuMeal extends Recipe {
    menuIndex: number;
    selected: boolean;
    nutritionPerServing?: {
        kcal: number;
        carbs_g: number;
        protein_g: number;
        fat_g: number;
    };
    mealOptions?: {
        recommendedExtrasHeadline: string;
        recommendedExtras: Array<{
            addonIndex: number;
            title: string;
            price?: number;
        }>;
        variations: Array<{
            variationIndex: number;
            title: string;
        }>;
    };
    display: {
        title: string;
        subtitle: string;
        imageUrl?: string;
        expectedCookingTimeMinutes: number;
        categories: string[];
        badges: string[];
        nutritionPerServing?: {
            kcal: number;
            carbs_g: number;
            protein_g: number;
            fat_g: number;
        };
        selected: boolean;
    };
}
export interface WeekPlanMealInput extends MealSelectionInput {
    extras?: Array<{
        addonIndex: number;
        quantity?: number;
    }>;
}
export interface HelloFreshBrowserOptions {
    baseUrl?: string;
    country?: string;
    locale?: string;
    headless?: boolean;
    sessionPath?: string;
    apiTimeoutMs?: number;
}
export declare class HelloFreshBrowser {
    private browser;
    private context;
    private page;
    private isLoggedIn;
    private loginLandingUrl;
    private readonly baseUrl;
    private readonly country;
    private readonly locale;
    private readonly headless;
    private readonly sessionPath;
    private readonly apiTimeoutMs;
    private apiSession;
    constructor(options?: HelloFreshBrowserOptions);
    init(): Promise<void>;
    login(credentials: HelloFreshCredentials): Promise<void>;
    private performInteractiveLogin;
    private waitForEditableLocator;
    private isTransientLoginError;
    getMenu(weekOffset?: number): Promise<Recipe[]>;
    getRecipeDetails(recipeId: string): Promise<RecipeDetails>;
    getDeliverySchedule(): Promise<DeliveryInfo[]>;
    getMenuForWeek(weekId: string): Promise<WeekMenuMeal[]>;
    getRecommendedExtras(weekId: string, mealRecipeIds?: string[]): Promise<RecommendedExtraOption[]>;
    previewMealExtras(weekId: string, extraSelections: MealExtraInput[]): Promise<MealExtrasPreview>;
    setMealExtras(weekId: string, extraSelections: MealExtraInput[]): Promise<{
        success: boolean;
        message: string;
        addedExtras: RecommendedExtraSelection[];
        totalExtraCost: number;
    }>;
    previewWeekPlan(args: {
        weekId: string;
        meals: WeekPlanMealInput[];
    }): Promise<WeekPlanPreview>;
    applyWeekPlan(args: {
        weekId: string;
        meals: WeekPlanMealInput[];
    }): Promise<{
        success: boolean;
        mealSelection?: {
            success: boolean;
            message: string;
            preview?: MealSelectionPreview;
        };
        extrasApplied?: {
            success: boolean;
            message: string;
            addedExtras: RecommendedExtraSelection[];
            totalExtraCost: number;
        };
    }>;
    previewSelectMeals(weekId: string, mealSelections: MealSelectionInput[]): Promise<MealSelectionPreview>;
    selectMeals(weekId: string, mealSelections: MealSelectionInput[]): Promise<{
        success: boolean;
        message: string;
        preview?: MealSelectionPreview;
    }>;
    addRecommendedExtras(weekId: string): Promise<{
        success: boolean;
        message: string;
        addedExtras: RecommendedExtraSelection[];
        totalExtraCost: number;
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
    private ensureLoggedIn;
    private ensurePage;
    private hydrateContextCookies;
    private parseApiRecipes;
    private findRecipeInMenus;
    private recipeLookupWeeks;
    private findRecipeInMenu;
    private recipeDetailsFromMenuRecipe;
    private mergeScrapedRecipeDetails;
    private hasMeaningfulRecipeDetails;
    private recipeTags;
    private parseNutritionInfo;
    private parseIngredients;
    private parseInstructions;
    private parseAllergens;
    private parseUtensils;
    private normalizeDeliveryRecord;
    private deliveryNeedsMenuLookup;
    private deliveryCanModify;
    private normalizeOrderRecord;
    private selectedMealsFromUnknownItems;
    private getOrderDetailRecord;
    private normalizeCurrencyAmount;
    private loadPreferenceApiRecords;
    private preferencesFromApiRecords;
    private preferenceStrings;
    private preferenceBoolean;
    private preferenceNumber;
    private preferenceFieldValues;
    private collectPreferenceStrings;
    private scrapePreferencesFromPage;
    private captureBrowserSession;
    private apiGet;
    private apiRequest;
    private apiFetch;
    private fetchWithTimeout;
    private parseApiResponse;
    private ensureApiSession;
    private activateStoredSession;
    private refreshApiSession;
    private loadSession;
    private saveSession;
    private cookieHeader;
    private upsertAuthCookie;
    private getPrimarySubscriptionRecord;
    private getDeliveryRecords;
    private buildMealSelectionPlan;
    private resolveMealSelections;
    private mealSelectionBlockReason;
    private selectedMealsFromMenu;
    private selectedMealRecords;
    private selectedMealsFromMealRecords;
    private mealRecordsForResolvedSelections;
    private buildCartMutationPath;
    private previewMealSelectionPrice;
    private getDeliveryByWeek;
    private getMenuWeek;
    private buildMenuApiPath;
    private buildAddonSelections;
    private addonCatalog;
    private selectAddonForCourse;
    private recommendedExtrasFromMenu;
    private weekMenuMealsFromMenu;
    private resolveExtraSelections;
    private selectedAddons;
    private scrapeRecipesFromCurrentPage;
    private scrapeDeliveryScheduleFromCurrentPage;
    private scrapeSubscriptionFromCurrentPage;
    private scrapePastOrdersFromCurrentPage;
    private acceptCookiesIfPresent;
    private clickSubmitFallback;
    private extractLoginError;
    private setCheckboxByLocator;
    private selectPlanOption;
    private static normalizeBaseUrl;
    private static baseUrlForCountry;
    private static countryFromBaseUrl;
    private static localeForCountry;
    private static diffMeals;
    private static parseAuthCookie;
    private static isAccessTokenExpired;
    private static isRefreshTokenExpired;
    private static authExpirySeconds;
    private static asArray;
    private static recordValue;
    private static stringValue;
    private static maybeNumber;
    private static uniqueStrings;
    private static optionalString;
    private static numberValue;
    private static durationMinutes;
    private static isoWeekOffset;
    private static addIsoWeeks;
    private static isoWeek;
}
//# sourceMappingURL=browser.d.ts.map