"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HelloFreshBrowser = void 0;
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const playwright_extra_1 = require("playwright-extra");
const puppeteer_extra_plugin_stealth_1 = __importDefault(require("puppeteer-extra-plugin-stealth"));
playwright_extra_1.chromium.use((0, puppeteer_extra_plugin_stealth_1.default)());
class HelloFreshBrowser {
    browser = null;
    context = null;
    page = null;
    isLoggedIn = false;
    loginLandingUrl = null;
    baseUrl;
    country;
    locale;
    headless;
    sessionPath;
    apiTimeoutMs;
    apiSession = null;
    constructor(options = {}) {
        this.baseUrl = HelloFreshBrowser.normalizeBaseUrl(options.baseUrl ?? HelloFreshBrowser.baseUrlForCountry(options.country));
        this.country = (options.country ?? HelloFreshBrowser.countryFromBaseUrl(this.baseUrl)).toUpperCase();
        this.locale = options.locale ?? HelloFreshBrowser.localeForCountry(this.country);
        this.headless = options.headless ?? true;
        this.sessionPath =
            options.sessionPath ?? (0, node_path_1.join)((0, node_os_1.homedir)(), ".config", "mcp-hellofresh", `${this.country.toLowerCase()}-session.json`);
        this.apiTimeoutMs = Math.max(1_000, options.apiTimeoutMs ?? 15_000);
    }
    async init() {
        if (!this.browser) {
            const launchOptions = {
                headless: this.headless,
                args: ["--no-sandbox", "--disable-setuid-sandbox"],
            };
            try {
                this.browser = await playwright_extra_1.chromium.launch(launchOptions);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`Unable to launch Playwright Chromium. Run "npx playwright install chromium" before starting this MCP. ${message}`);
            }
        }
        if (!this.context) {
            this.context = await this.browser.newContext({
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                viewport: { width: 1280, height: 720 },
                locale: this.locale,
            });
        }
        if (!this.page) {
            this.page = await this.context.newPage();
        }
    }
    async login(credentials) {
        const storedSession = await this.loadSession();
        if (storedSession && (await this.activateStoredSession(storedSession))) {
            this.isLoggedIn = true;
            return;
        }
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                await this.init();
                const page = await this.ensurePage();
                await this.performInteractiveLogin(page, credentials);
                this.loginLandingUrl = page.url();
                await this.captureBrowserSession();
                this.isLoggedIn = true;
                return;
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                if (!this.isTransientLoginError(lastError) || attempt === 1) {
                    throw lastError;
                }
                await this.close();
            }
        }
        throw lastError ?? new Error(`Login failed for ${this.baseUrl}.`);
    }
    async performInteractiveLogin(page, credentials) {
        await page.goto(`${this.baseUrl}/login`, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
        await this.acceptCookiesIfPresent(page);
        const emailInput = page
            .locator('input[type="email"], input[name="username"], input[name="email"], input[id*="email"], input[id*="username"]')
            .first();
        const passwordInput = page
            .locator('input[type="password"], input[name="password"], input[id*="password"]')
            .first();
        await this.waitForEditableLocator(emailInput, "email");
        await emailInput.fill(credentials.email);
        await this.waitForEditableLocator(passwordInput, "password");
        await passwordInput.fill(credentials.password);
        await Promise.all([
            page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 20_000 }).catch(() => null),
            passwordInput.press("Enter"),
        ]);
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
        if (new URL(page.url()).pathname.includes("/login")) {
            await this.clickSubmitFallback(page);
            await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15_000 }).catch(() => null);
            await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
        }
        if (new URL(page.url()).pathname.includes("/login")) {
            const errorMsg = await this.extractLoginError(page);
            throw new Error(`Login failed for ${this.baseUrl}: ${errorMsg}`);
        }
    }
    async waitForEditableLocator(locator, label) {
        await locator.waitFor({ state: "visible", timeout: 30_000 });
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            const disabled = await locator.isDisabled().catch(() => true);
            if (!disabled)
                return;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(`HelloFresh login ${label} field did not become editable.`);
    }
    isTransientLoginError(error) {
        return /page crashed|err_insufficient_resources|did not become editable|timeout/i.test(error.message);
    }
    async getMenu(weekOffset = 0) {
        await this.ensureLoggedIn();
        try {
            const subscription = await this.getPrimarySubscriptionRecord();
            const week = await this.getMenuWeek(subscription, weekOffset);
            const path = this.buildMenuApiPath(subscription, week);
            const menu = await this.apiGet(path);
            const meals = HelloFreshBrowser.asArray(menu.meals ?? menu.recipes);
            if (meals.length > 0)
                return this.parseApiRecipes(meals);
        }
        catch {
            // Fall back to page scraping below; some countries expose different API shapes.
        }
        const page = await this.ensurePage();
        const target = this.loginLandingUrl?.includes("/my-account/deliveries/menu")
            ? this.loginLandingUrl
            : `${this.baseUrl}/my-account/deliveries/menu`;
        await page.goto(target, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
        return this.scrapeRecipesFromCurrentPage();
    }
    async getRecipeDetails(recipeId) {
        await this.ensureLoggedIn();
        const errors = [];
        let apiDetails = null;
        try {
            const match = await this.findRecipeInMenus(recipeId);
            if (match) {
                apiDetails = this.recipeDetailsFromMenuRecipe(recipeId, match.recipe, match.meal);
                if (this.hasMeaningfulRecipeDetails(apiDetails)) {
                    return apiDetails;
                }
                errors.push(`menu API details were incomplete for recipe ${recipeId}`);
            }
            else {
                errors.push(`recipe ${recipeId} was not found in accessible menu API data`);
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`menu API lookup failed: ${message}`);
        }
        try {
            const page = await this.ensurePage();
            await page.goto(`${this.baseUrl}/recipes/${recipeId}`, { waitUntil: "domcontentloaded" });
            await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
            const scraped = await page.evaluate(() => {
                const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? "";
                const texts = (selector) => Array.from(document.querySelectorAll(selector))
                    .map((el) => el.textContent?.trim() ?? "")
                    .filter(Boolean);
                const nutritionData = {};
                document
                    .querySelectorAll("[data-testid*='nutrition'] tr, [class*='Nutrition'] tr, [class*='nutrition'] tr")
                    .forEach((el) => {
                    const label = el.querySelector("td:first-child, th")?.textContent?.trim().toLowerCase() ?? "";
                    const value = Number.parseFloat(el.querySelector("td:last-child")?.textContent ?? "0");
                    if (!Number.isFinite(value))
                        return;
                    if (label.includes("calorie") || label.includes("energy") || label.includes("kcal"))
                        nutritionData.calories = value;
                    else if (label.includes("fat") && !label.includes("saturated"))
                        nutritionData.fat = value;
                    else if (label.includes("saturated"))
                        nutritionData.saturatedFat = value;
                    else if (label.includes("carb"))
                        nutritionData.carbohydrates = value;
                    else if (label.includes("sugar"))
                        nutritionData.sugar = value;
                    else if (label.includes("protein"))
                        nutritionData.protein = value;
                    else if (label.includes("fiber"))
                        nutritionData.fiber = value;
                    else if (label.includes("sodium") || label.includes("salt"))
                        nutritionData.sodium = value;
                });
                return {
                    name: text("h1, [data-testid='recipe-title'], [class*='RecipeTitle']"),
                    description: text("[data-testid='recipe-description'], [class*='Description']"),
                    ingredients: Array.from(document.querySelectorAll("[data-testid*='ingredient'], [class*='Ingredient'], .ingredient")).map((el) => ({
                        name: el.querySelector("[class*='name'], .name")?.textContent?.trim() || el.textContent?.trim() || "",
                        amount: el.querySelector("[class*='amount'], .amount")?.textContent?.trim() || "",
                        unit: el.querySelector("[class*='unit'], .unit")?.textContent?.trim() || "",
                    })),
                    instructions: texts("[data-testid*='instruction'], [class*='Step'], .step"),
                    nutrition: nutritionData,
                    allergens: texts("[data-testid*='allergen'], [class*='Allergen'], [class*='allergen']"),
                    tags: texts("[data-testid*='recipe-tag'], [class*='Tag'], [class*='badge']"),
                    totalTime: Number.parseInt(text("[class*='time'], [data-testid*='time']"), 10) || undefined,
                    difficulty: text("[class*='difficulty']"),
                };
            });
            return this.mergeScrapedRecipeDetails(recipeId, scraped, apiDetails);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`page fallback failed: ${message}`);
        }
        throw new Error(`Unable to load recipe details for ${recipeId}. ${errors.join(" | ")}`);
    }
    async getDeliverySchedule() {
        await this.ensureLoggedIn();
        try {
            const deliveries = await this.getDeliveryRecords(12);
            let subscription = null;
            const normalized = [];
            for (const delivery of deliveries) {
                const info = this.normalizeDeliveryRecord(delivery);
                if (info.weekId && info.meals.length === 0 && this.deliveryNeedsMenuLookup(info)) {
                    subscription ??= await this.getPrimarySubscriptionRecord();
                    const menu = await this.apiGet(this.buildMenuApiPath(subscription, info.weekId));
                    const selectedMeals = this.selectedMealsFromMenu(menu);
                    if (selectedMeals.length > 0) {
                        info.meals = selectedMeals;
                    }
                }
                normalized.push(info);
            }
            return normalized;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("timed out")) {
                throw error;
            }
            return this.scrapeDeliveryScheduleFromCurrentPage(8_000);
        }
    }
    async getMenuForWeek(weekId) {
        await this.ensureLoggedIn();
        const subscription = await this.getPrimarySubscriptionRecord();
        const menu = await this.apiGet(this.buildMenuApiPath(subscription, weekId));
        return this.weekMenuMealsFromMenu(menu);
    }
    async getRecommendedExtras(weekId, mealRecipeIds) {
        await this.ensureLoggedIn();
        const subscription = await this.getPrimarySubscriptionRecord();
        const menu = await this.apiGet(this.buildMenuApiPath(subscription, weekId));
        const selectedMeals = HelloFreshBrowser.asArray(menu.meals)
            .map((meal) => HelloFreshBrowser.recordValue(meal))
            .filter((meal) => Boolean(meal))
            .filter((meal) => mealRecipeIds?.length
            ? mealRecipeIds.includes(HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(meal.recipe)?.id))
            : Boolean(meal.selection));
        return this.recommendedExtrasFromMenu(menu, selectedMeals);
    }
    async previewMealExtras(weekId, extraSelections) {
        await this.ensureLoggedIn();
        const subscription = await this.getPrimarySubscriptionRecord();
        const menu = await this.apiGet(this.buildMenuApiPath(subscription, weekId));
        const meals = this.selectedMealRecords(menu);
        const resolvedSelections = this.resolveExtraSelections(meals, menu, extraSelections);
        return {
            weekId,
            canApply: true,
            selectedMeals: this.selectedMealsFromMealRecords(meals),
            requestedExtras: resolvedSelections,
            totalExtraCost: resolvedSelections.reduce((total, extra) => total + extra.price * (extra.quantity ?? 1), 0),
        };
    }
    async setMealExtras(weekId, extraSelections) {
        await this.ensureLoggedIn();
        const subscription = await this.getPrimarySubscriptionRecord();
        const delivery = await this.getDeliveryByWeek(subscription, weekId);
        const menu = await this.apiGet(this.buildMenuApiPath(subscription, weekId));
        const meals = HelloFreshBrowser.asArray(menu.meals)
            .map((meal) => HelloFreshBrowser.recordValue(meal))
            .filter((meal) => Boolean(meal?.selection));
        const resolvedSelections = this.resolveExtraSelections(meals, menu, extraSelections);
        const totalExtraCost = resolvedSelections.reduce((total, extra) => total + extra.price * (extra.quantity ?? 1), 0);
        const extras = this.buildAddonSelections(menu);
        for (const extra of resolvedSelections) {
            this.selectAddonForCourse(extras, extra.addonIndex, extra.mealIndex, extra.quantity ?? 1);
        }
        await this.apiRequest(this.buildCartMutationPath(subscription, delivery, weekId), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                extras,
                meals: meals.map((meal) => ({
                    index: HelloFreshBrowser.numberValue(meal.index, 0),
                    quantity: HelloFreshBrowser.numberValue(HelloFreshBrowser.recordValue(meal.selection)?.quantity, 1),
                })),
            }),
        });
        const updated = await this.apiGet(this.buildMenuApiPath(subscription, weekId));
        const selectedAddonIndexes = new Set(this.selectedAddons(updated).map((addon) => addon.addonIndex));
        const verified = resolvedSelections.every((extra) => selectedAddonIndexes.has(extra.addonIndex));
        return {
            success: verified,
            message: verified
                ? `Applied ${resolvedSelections.length} explicit extras to ${weekId}.`
                : `Explicit extras request completed, but read-back verification did not match all extras.`,
            addedExtras: resolvedSelections.map((extra) => ({
                mealIndex: extra.mealIndex,
                mealName: extra.mealName,
                addonIndex: extra.addonIndex,
                addonName: extra.addonName,
                price: extra.price,
            })),
            totalExtraCost,
        };
    }
    async previewWeekPlan(args) {
        await this.ensureLoggedIn();
        const mealInputs = args.meals.map((meal) => ({
            recipeId: meal.recipeId,
            servings: meal.servings,
        }));
        const mealSelection = await this.buildMealSelectionPlan(args.weekId, mealInputs);
        const hypotheticalMealRecords = this.mealRecordsForResolvedSelections(mealSelection.menu, mealSelection.resolvedMeals);
        const premiumCharges = mealSelection.preview.price?.premiumCharges ?? 0;
        const flattenedExtras = args.meals.flatMap((meal) => (meal.extras ?? []).map((extra) => ({
            addonIndex: extra.addonIndex,
            mealRecipeId: meal.recipeId,
            quantity: extra.quantity,
        })));
        let explicitExtras;
        if (flattenedExtras.length > 0) {
            const resolvedSelections = this.resolveExtraSelections(hypotheticalMealRecords, mealSelection.menu, flattenedExtras);
            const totalExtraCost = resolvedSelections.reduce((total, extra) => total + extra.price * (extra.quantity ?? 1), 0);
            explicitExtras = {
                weekId: args.weekId,
                canApply: true,
                selectedMeals: mealSelection.preview.requestedMeals,
                requestedExtras: resolvedSelections,
                totalExtraCost,
            };
        }
        const extrasCost = explicitExtras?.totalExtraCost ?? 0;
        return {
            weekId: args.weekId,
            canApply: mealSelection.preview.canSelect,
            mealSelection: mealSelection.preview,
            explicitExtras,
            totalExtraCost: premiumCharges + extrasCost,
        };
    }
    async applyWeekPlan(args) {
        const mealInputs = args.meals.map((meal) => ({
            recipeId: meal.recipeId,
            servings: meal.servings,
        }));
        const mealSelection = await this.selectMeals(args.weekId, mealInputs);
        if (!mealSelection.success)
            return { success: false, mealSelection };
        const flattenedExtras = args.meals.flatMap((meal) => (meal.extras ?? []).map((extra) => ({
            addonIndex: extra.addonIndex,
            mealRecipeId: meal.recipeId,
            quantity: extra.quantity,
        })));
        let extrasApplied;
        if (flattenedExtras.length > 0) {
            extrasApplied = await this.setMealExtras(args.weekId, flattenedExtras);
            if (!extrasApplied.success)
                return { success: false, mealSelection, extrasApplied };
        }
        return { success: true, mealSelection, extrasApplied };
    }
    async previewSelectMeals(weekId, mealSelections) {
        await this.ensureLoggedIn();
        return (await this.buildMealSelectionPlan(weekId, mealSelections)).preview;
    }
    async selectMeals(weekId, mealSelections) {
        await this.ensureLoggedIn();
        const plan = await this.buildMealSelectionPlan(weekId, mealSelections);
        if (!plan.preview.canSelect) {
            return {
                success: false,
                message: plan.preview.reason ?? "Meal selection is not allowed.",
                preview: plan.preview,
            };
        }
        await this.apiRequest(plan.mutationPath, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(plan.mutationBody),
        });
        const updatedMenu = await this.apiGet(this.buildMenuApiPath(plan.subscription, weekId));
        const selectedIndexes = new Map(plan.resolvedMeals.map((meal) => [meal.index, meal.quantity]));
        const selectedAfterUpdate = HelloFreshBrowser.asArray(updatedMenu.meals)
            .map((meal) => HelloFreshBrowser.recordValue(meal))
            .filter((meal) => Boolean(meal?.selection));
        const verified = selectedAfterUpdate.length === plan.resolvedMeals.length &&
            selectedAfterUpdate.every((meal) => {
                const selection = HelloFreshBrowser.recordValue(meal.selection);
                const index = HelloFreshBrowser.numberValue(meal.index, 0);
                return selectedIndexes.get(index) === HelloFreshBrowser.numberValue(selection?.quantity, 0);
            });
        return {
            success: verified,
            message: verified
                ? `Successfully selected ${plan.requestedMealCount} meals for week ${weekId}: ${plan.resolvedMeals.map((meal) => meal.name || meal.index).join(", ")}`
                : `Meal selection request for week ${weekId} completed, but read-back verification did not match the requested meals.`,
            preview: plan.preview,
        };
    }
    async addRecommendedExtras(weekId) {
        await this.ensureLoggedIn();
        const subscription = await this.getPrimarySubscriptionRecord();
        const delivery = await this.getDeliveryByWeek(subscription, weekId);
        const menu = await this.apiGet(this.buildMenuApiPath(subscription, weekId));
        const meals = HelloFreshBrowser.asArray(menu.meals)
            .map((meal) => HelloFreshBrowser.recordValue(meal))
            .filter((meal) => Boolean(meal?.selection))
            .map((meal) => ({
            index: HelloFreshBrowser.numberValue(meal.index, 0),
            quantity: HelloFreshBrowser.numberValue(HelloFreshBrowser.recordValue(meal.selection)?.quantity, 1),
            name: HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(meal.recipe)?.name),
        }));
        const selectedIndexes = new Set(meals.map((meal) => meal.index));
        const addonCatalog = this.addonCatalog(menu);
        const extras = this.buildAddonSelections(menu);
        const addedExtras = [];
        for (const module of HelloFreshBrowser.asArray(menu.modularity)) {
            const record = HelloFreshBrowser.recordValue(module);
            if (!record)
                continue;
            const mealIndex = HelloFreshBrowser.numberValue(record.defaultCourseIndex, 0);
            if (!selectedIndexes.has(mealIndex))
                continue;
            const mealName = meals.find((meal) => meal.index === mealIndex)?.name ?? "";
            const addOns = HelloFreshBrowser.asArray(record.addOns)
                .map((addOn) => HelloFreshBrowser.recordValue(addOn))
                .filter((addOn) => Boolean(addOn));
            for (const addOn of addOns) {
                const addonIndex = HelloFreshBrowser.numberValue(addOn.index, 0);
                const catalog = addonCatalog.get(addonIndex);
                if (!catalog)
                    continue;
                this.selectAddonForCourse(extras, addonIndex, mealIndex);
                addedExtras.push({
                    mealIndex,
                    mealName,
                    addonIndex,
                    addonName: catalog.name,
                    price: catalog.price,
                });
            }
        }
        const totalExtraCost = addedExtras.reduce((total, extra) => total + extra.price, 0);
        if (addedExtras.length === 0) {
            return { success: false, message: `No recommended extras found for selected meals in ${weekId}.`, addedExtras, totalExtraCost };
        }
        await this.apiRequest(this.buildCartMutationPath(subscription, delivery, weekId), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                extras,
                meals: meals.map((meal) => ({ index: meal.index, quantity: meal.quantity })),
            }),
        });
        const updated = await this.apiGet(this.buildMenuApiPath(subscription, weekId));
        const selectedAddonIndexes = new Set(this.selectedAddons(updated).map((addon) => addon.addonIndex));
        const verified = addedExtras.every((extra) => selectedAddonIndexes.has(extra.addonIndex));
        return {
            success: verified,
            message: verified
                ? `Added ${addedExtras.length} recommended extras to ${weekId}.`
                : `Recommended extras request completed, but read-back verification did not match all extras.`,
            addedExtras,
            totalExtraCost,
        };
    }
    async skipWeek(weekId) {
        await this.ensureLoggedIn();
        const page = await this.ensurePage();
        await page.goto(`${this.baseUrl}/my-account/deliveries?week=${encodeURIComponent(weekId)}`, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
        const weekEl = page.locator(`[data-week="${weekId}"], [data-delivery-id="${weekId}"], text=${weekId}`).first();
        if (await weekEl.isVisible({ timeout: 5_000 }).catch(() => false)) {
            const skipBtn = page.locator('button:has-text("Skip"), button:has-text("Overslaan"), [data-testid*="skip"]').first();
            if (await skipBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
                await skipBtn.click();
                const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Yes"), button:has-text("Bevestig"), button:has-text("Ja"), [data-testid*="confirm"]').first();
                if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
                    await confirmBtn.click();
                }
                await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
                return { success: true, message: `Successfully skipped week ${weekId}` };
            }
        }
        return {
            success: false,
            message: `Could not find or skip week ${weekId}. It may not be available for skipping.`,
        };
    }
    async modifyDelivery(weekId, newDate) {
        await this.ensureLoggedIn();
        const page = await this.ensurePage();
        await page.goto(`${this.baseUrl}/my-account/deliveries?week=${encodeURIComponent(weekId)}`, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
        const modifyBtn = page.locator('button:has-text("Modify"), button:has-text("Change"), button:has-text("Wijzig"), button:has-text("Aanpassen"), [data-testid*="modify"]').first();
        if (await modifyBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
            await modifyBtn.click();
            const dateOption = page.locator(`[data-date="${newDate}"], option[value="${newDate}"]`).first();
            if (await dateOption.isVisible({ timeout: 5_000 }).catch(() => false)) {
                await dateOption.click();
            }
            else {
                const dateSelect = page.locator('select[name*="date"], select[id*="date"]').first();
                if (await dateSelect.isVisible({ timeout: 3_000 }).catch(() => false)) {
                    await dateSelect.selectOption(newDate);
                }
            }
            const saveBtn = page.locator('button:has-text("Save"), button:has-text("Confirm"), button:has-text("Opslaan"), button:has-text("Bevestig"), [data-testid*="save"]').first();
            if (await saveBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
                await saveBtn.click();
                await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
                return { success: true, message: `Delivery for week ${weekId} rescheduled to ${newDate}` };
            }
        }
        return { success: false, message: `Could not modify delivery for week ${weekId}.` };
    }
    async getPreferences() {
        await this.ensureLoggedIn();
        const errors = [];
        try {
            const records = await this.loadPreferenceApiRecords();
            const preferences = this.preferencesFromApiRecords(records);
            if (preferences) {
                return preferences;
            }
            errors.push("authenticated API did not expose recognizable preference fields");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`API lookup failed: ${message}`);
        }
        try {
            const preferences = await this.scrapePreferencesFromPage();
            if (preferences) {
                return preferences;
            }
            errors.push("preferences page did not expose recognizable preference controls");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`page fallback failed: ${message}`);
        }
        throw new Error(`HelloFresh preferences are not exposed for this account or region. ${errors.join(" | ")}`);
    }
    async updatePreferences(preferences) {
        await this.ensureLoggedIn();
        const requestedFields = Object.entries(preferences)
            .filter(([, value]) => value !== undefined)
            .map(([key]) => key);
        if (requestedFields.length === 0) {
            return { success: false, message: "No preference changes were requested." };
        }
        const page = await this.ensurePage();
        await page.goto(`${this.baseUrl}/my-account/preferences`, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
        let handledControls = 0;
        let changedControls = 0;
        if (preferences.vegetarian !== undefined) {
            const result = await this.setCheckboxByLocator(page.locator('input[value*="vegetarian"], input[value*="veggie"], [data-testid*="vegetarian"], [data-testid*="veggie"]').first(), preferences.vegetarian);
            handledControls += Number(result.found);
            changedControls += Number(result.changed);
        }
        if (preferences.familyFriendly !== undefined) {
            const result = await this.setCheckboxByLocator(page.locator('input[value*="family"], input[value*="familie"], [data-testid*="family"], [data-testid*="familie"]').first(), preferences.familyFriendly);
            handledControls += Number(result.found);
            changedControls += Number(result.changed);
        }
        const unsupportedFields = requestedFields.filter((field) => !["vegetarian", "familyFriendly"].includes(field));
        if (handledControls === 0) {
            return {
                success: false,
                message: `Could not find editable preference controls for requested fields: ${requestedFields.join(", ")}.`,
            };
        }
        if (changedControls === 0 && unsupportedFields.length === 0) {
            return {
                success: true,
                message: "Requested preference values already match the current page state.",
            };
        }
        const saveBtn = page.locator('button:has-text("Save"), button:has-text("Opslaan"), button[type="submit"], [data-testid*="save-preferences"]').first();
        if (!(await saveBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
            return {
                success: false,
                message: `Preference controls were found, but no save action was available.${unsupportedFields.length > 0 ? ` Unsupported fields: ${unsupportedFields.join(", ")}.` : ""}`,
            };
        }
        await saveBtn.click();
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
        return {
            success: unsupportedFields.length === 0,
            message: unsupportedFields.length === 0
                ? "Preferences updated successfully."
                : `Updated supported preferences, but these fields were not editable here: ${unsupportedFields.join(", ")}.`,
        };
    }
    async getSubscription() {
        await this.ensureLoggedIn();
        try {
            const subscription = await this.getPrimarySubscriptionRecord();
            const product = HelloFreshBrowser.recordValue(subscription.product);
            const specs = HelloFreshBrowser.recordValue(product?.specs);
            const productType = HelloFreshBrowser.recordValue(subscription.productType);
            const typeSpecs = HelloFreshBrowser.recordValue(productType?.specs);
            const meals = HelloFreshBrowser.numberValue(specs?.meals ?? typeSpecs?.meals, 0);
            const servings = HelloFreshBrowser.numberValue(specs?.size ?? typeSpecs?.size, 0);
            const unitPrice = HelloFreshBrowser.numberValue(product?.unitPrice ?? productType?.price, 0);
            return {
                planId: HelloFreshBrowser.stringValue(subscription.id ?? subscription.customerPlanId),
                mealsPerWeek: meals,
                servingsPerMeal: servings,
                frequency: HelloFreshBrowser.numberValue(subscription.deliveryInterval, 1) === 2 ? "biweekly" : "weekly",
                pricePerServing: meals > 0 && servings > 0 ? unitPrice / meals / servings / 100 : 0,
                nextDeliveryDate: HelloFreshBrowser.stringValue(subscription.nextDelivery ?? subscription.nextModifiableDeliveryDate),
                status: subscription.isActive === false || subscription.pausedAt ? "Paused" : "Active",
            };
        }
        catch {
            return this.scrapeSubscriptionFromCurrentPage();
        }
    }
    async modifySubscription(changes) {
        await this.ensureLoggedIn();
        const page = await this.ensurePage();
        await page.goto(`${this.baseUrl}/my-account/plan`, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
        let changed = false;
        if (changes.mealsPerWeek !== undefined) {
            changed = (await this.selectPlanOption(page, "meals", changes.mealsPerWeek)) || changed;
        }
        if (changes.servingsPerMeal !== undefined) {
            changed = (await this.selectPlanOption(page, "servings", changes.servingsPerMeal)) || changed;
        }
        if (changed) {
            const saveBtn = page.locator('button:has-text("Save Changes"), button:has-text("Update Plan"), button:has-text("Opslaan"), button:has-text("Bijwerken"), button[type="submit"]').first();
            if (await saveBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
                await saveBtn.click();
                await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
            }
        }
        const details = Object.entries(changes)
            .map(([key, value]) => `${key}: ${value}`)
            .join(", ");
        return {
            success: changed,
            message: changed
                ? `Subscription updated: ${details}`
                : "No changes could be applied. Please verify the plan options.",
        };
    }
    async getPastOrders(limit = 10) {
        await this.ensureLoggedIn();
        try {
            const data = await this.apiGet(`/gw/api/customers/me/orders?country=${encodeURIComponent(this.country)}&limit=${encodeURIComponent(String(limit))}&locale=${encodeURIComponent(this.locale)}`);
            const orders = [];
            const incompleteOrders = [];
            for (const order of HelloFreshBrowser.asArray(data.items ?? data.orders).slice(0, limit)) {
                const summary = HelloFreshBrowser.recordValue(order) ?? {};
                let normalized = this.normalizeOrderRecord(summary);
                if ((!normalized.deliveryDate || normalized.meals.length === 0) && normalized.orderId) {
                    try {
                        const detailResponse = await this.getOrderDetailRecord(normalized.orderId);
                        const detail = HelloFreshBrowser.recordValue(detailResponse.item ?? detailResponse.order) ?? detailResponse;
                        normalized = this.normalizeOrderRecord({ ...summary, ...detail });
                    }
                    catch {
                        // Keep the summary result and assess completeness below.
                    }
                }
                if (!normalized.deliveryDate || normalized.meals.length === 0) {
                    incompleteOrders.push(normalized.orderId || "<unknown>");
                }
                orders.push(normalized);
            }
            if (orders.length > 0 && incompleteOrders.length === orders.length) {
                throw new Error(`HelloFresh orders API returned partial data for all requested orders even after detail lookups: ${incompleteOrders.join(", ")}`);
            }
            return orders;
        }
        catch (error) {
            const original = error instanceof Error ? error : new Error(String(error));
            try {
                const scraped = await this.scrapePastOrdersFromCurrentPage(limit);
                if (scraped.some((order) => order.deliveryDate || order.meals.length > 0)) {
                    return scraped;
                }
            }
            catch (fallbackError) {
                const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                throw new Error(`${original.message} | page fallback failed: ${fallbackMessage}`);
            }
            throw original;
        }
    }
    async rateRecipe(recipeId, rating, comment) {
        await this.ensureLoggedIn();
        const page = await this.ensurePage();
        await page.goto(`${this.baseUrl}/recipes/${recipeId}`, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
        const starBtn = page.locator(`[data-rating="${rating}"], [aria-label*="${rating} star"], [aria-label*="${rating} ster"], .star:nth-child(${rating})`).first();
        if (await starBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
            await starBtn.click();
            if (comment) {
                const commentInput = page.locator('textarea[name*="comment"], textarea[placeholder*="comment"], textarea[placeholder*="review"], textarea[placeholder*="beoordeling"]').first();
                if (await commentInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
                    await commentInput.fill(comment);
                }
            }
            const submitBtn = page.locator('button:has-text("Submit"), button:has-text("Rate"), button:has-text("Verstuur"), button:has-text("Beoordeel"), button[type="submit"]').first();
            if (await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
                await submitBtn.click();
                await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
            }
            return {
                success: true,
                message: `Recipe ${recipeId} rated ${rating}/5 stars${comment ? " with comment" : ""}.`,
            };
        }
        return {
            success: false,
            message: "Rating interface not found. Recipe may not be available for rating.",
        };
    }
    async close() {
        if (this.page) {
            await this.page.close().catch(() => { });
            this.page = null;
        }
        if (this.context) {
            await this.context.close().catch(() => { });
            this.context = null;
        }
        if (this.browser) {
            await this.browser.close().catch(() => { });
            this.browser = null;
        }
        this.isLoggedIn = false;
        this.loginLandingUrl = null;
    }
    async ensureLoggedIn() {
        if (!this.isLoggedIn) {
            throw new Error("Not logged in. Please provide HELLOFRESH_EMAIL and HELLOFRESH_PASSWORD environment variables.");
        }
    }
    async ensurePage() {
        if (!this.browser || !this.context || !this.page) {
            await this.init();
        }
        if (!this.context || !this.page) {
            throw new Error("HelloFresh browser page is not initialized.");
        }
        if (this.apiSession?.cookies.length) {
            await this.hydrateContextCookies(this.context, this.apiSession.cookies);
        }
        return this.page;
    }
    async hydrateContextCookies(context, cookies) {
        const nowSeconds = Date.now() / 1000;
        const secure = new URL(this.baseUrl).protocol === "https:";
        const activeCookies = cookies
            .filter((cookie) => !cookie.expires || cookie.expires < 0 || cookie.expires > nowSeconds)
            .map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: cookie.expires,
            httpOnly: false,
            secure,
        }));
        if (activeCookies.length === 0)
            return;
        await context.addCookies(activeCookies);
    }
    parseApiRecipes(apiRecipes) {
        return apiRecipes
            .map((entry) => {
            const item = HelloFreshBrowser.recordValue(entry) ?? {};
            const recipe = HelloFreshBrowser.recordValue(item.recipe) ?? item;
            const nutrition = HelloFreshBrowser.recordValue(recipe.nutrition);
            const tags = HelloFreshBrowser.asArray(recipe.tags).map((tag) => HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(tag)?.name ?? tag));
            const totalTime = HelloFreshBrowser.durationMinutes(recipe.totalTime ?? recipe.prepTime) ||
                HelloFreshBrowser.numberValue(recipe.totalTime, 40);
            const rawPrepTime = HelloFreshBrowser.durationMinutes(recipe.prepTime);
            const prepTime = rawPrepTime > 0 ? Math.min(rawPrepTime, totalTime) : Math.min(totalTime, 10);
            const calories = HelloFreshBrowser.numberValue(nutrition?.calories ?? nutrition?.energyKcal ?? recipe.calories, 0);
            const cuisines = HelloFreshBrowser.asArray(recipe.cuisines);
            return {
                id: HelloFreshBrowser.stringValue(recipe.id),
                name: HelloFreshBrowser.stringValue(recipe.name),
                description: HelloFreshBrowser.stringValue(recipe.headline ?? recipe.description),
                imageUrl: HelloFreshBrowser.optionalString(recipe.image ?? recipe.imageLink ?? recipe.imageUrl),
                prepTime,
                cookTime: Math.max(totalTime - prepTime, 0),
                totalTime,
                difficulty: HelloFreshBrowser.stringValue(recipe.difficulty || recipe.difficultyLevel || "Medium"),
                calories,
                servings: HelloFreshBrowser.numberValue(item.servings ?? recipe.yields, 2),
                tags,
                cuisineType: HelloFreshBrowser.stringValue(recipe.cuisineType ?? HelloFreshBrowser.recordValue(cuisines[0])?.name ?? ""),
                isVegetarian: tags.some((tag) => /vegetarian|veggie|vegetar/i.test(tag)),
                isFamily: tags.some((tag) => /family|familie/i.test(tag)),
            };
        })
            .filter((recipe) => recipe.id && recipe.name);
    }
    async findRecipeInMenus(recipeId) {
        const subscription = await this.getPrimarySubscriptionRecord();
        const weeks = await this.recipeLookupWeeks(subscription);
        for (const weekId of weeks) {
            const menu = await this.apiGet(this.buildMenuApiPath(subscription, weekId));
            const match = this.findRecipeInMenu(menu, recipeId);
            if (match)
                return match;
        }
        return null;
    }
    async recipeLookupWeeks(subscription) {
        const weeks = new Set();
        const addWeek = (value) => {
            const week = HelloFreshBrowser.stringValue(value);
            if (week)
                weeks.add(week);
        };
        addWeek(subscription.nextModifiableDeliveryWeek);
        addWeek(subscription.nextDeliveryWeek);
        for (let offset = 0; offset <= 5; offset += 1) {
            try {
                addWeek(await this.getMenuWeek(subscription, offset));
            }
            catch {
                // Ignore sparse menu-week lookups and continue with other candidates.
            }
        }
        const deliveries = await this.getDeliveryRecords(12).catch(() => []);
        for (const delivery of deliveries) {
            addWeek(delivery.id ?? delivery.week ?? delivery.hfWeek ?? delivery.deliveryWeek);
            const nestedDelivery = HelloFreshBrowser.recordValue(delivery.delivery);
            addWeek(nestedDelivery?.id ?? nestedDelivery?.week);
        }
        return Array.from(weeks);
    }
    findRecipeInMenu(menu, recipeId) {
        for (const item of HelloFreshBrowser.asArray(menu.meals ?? menu.recipes)) {
            const meal = HelloFreshBrowser.recordValue(item);
            if (!meal)
                continue;
            const recipe = HelloFreshBrowser.recordValue(meal.recipe) ?? meal;
            const candidateIds = [
                HelloFreshBrowser.stringValue(recipe.id),
                HelloFreshBrowser.stringValue(meal.recipeId),
                HelloFreshBrowser.stringValue(meal.id),
            ];
            if (candidateIds.includes(recipeId)) {
                return meal === recipe ? { recipe } : { recipe, meal };
            }
        }
        return null;
    }
    recipeDetailsFromMenuRecipe(recipeId, recipeRecord, mealRecord) {
        const detailSource = mealRecord ? { ...mealRecord, recipe: recipeRecord } : recipeRecord;
        const parsed = this.parseApiRecipes([detailSource])[0];
        const nutrition = this.parseNutritionInfo(detailSource);
        const base = parsed ?? {
            id: recipeId,
            name: HelloFreshBrowser.stringValue(recipeRecord.name || recipeId),
            description: HelloFreshBrowser.stringValue(recipeRecord.headline ?? recipeRecord.description),
            imageUrl: HelloFreshBrowser.optionalString(recipeRecord.image ?? recipeRecord.imageLink ?? recipeRecord.imageUrl),
            prepTime: 10,
            cookTime: 30,
            totalTime: HelloFreshBrowser.durationMinutes(recipeRecord.totalTime ?? recipeRecord.prepTime) || 40,
            difficulty: HelloFreshBrowser.stringValue((recipeRecord.difficulty ?? recipeRecord.difficultyLevel) || "Medium"),
            calories: nutrition.calories,
            servings: HelloFreshBrowser.numberValue(mealRecord?.servings ?? recipeRecord.yields, 2),
            tags: this.recipeTags(recipeRecord),
        };
        return {
            ...base,
            id: recipeId,
            calories: nutrition.calories || base.calories,
            ingredients: this.parseIngredients(recipeRecord),
            instructions: this.parseInstructions(recipeRecord),
            nutrition: {
                ...nutrition,
                calories: nutrition.calories || base.calories,
            },
            allergens: this.parseAllergens(recipeRecord),
            utensils: this.parseUtensils(recipeRecord),
        };
    }
    mergeScrapedRecipeDetails(recipeId, scraped, base) {
        const fallback = base ?? {
            id: recipeId,
            name: scraped.name || recipeId,
            description: scraped.description || "",
            prepTime: 10,
            cookTime: 30,
            totalTime: scraped.totalTime ?? 40,
            difficulty: scraped.difficulty || "Medium",
            calories: scraped.nutrition.calories || 0,
            servings: 2,
            tags: scraped.tags,
            ingredients: [],
            instructions: [],
            nutrition: {
                calories: 0,
                fat: 0,
                saturatedFat: 0,
                carbohydrates: 0,
                sugar: 0,
                protein: 0,
                fiber: 0,
                sodium: 0,
            },
            allergens: [],
            utensils: [],
        };
        return {
            ...fallback,
            name: scraped.name || fallback.name,
            description: scraped.description || fallback.description,
            totalTime: scraped.totalTime ?? fallback.totalTime,
            cookTime: Math.max((scraped.totalTime ?? fallback.totalTime) - fallback.prepTime, 0),
            difficulty: scraped.difficulty || fallback.difficulty,
            calories: scraped.nutrition.calories || fallback.calories,
            ingredients: scraped.ingredients.length > 0 ? scraped.ingredients : fallback.ingredients,
            instructions: scraped.instructions.length > 0 ? scraped.instructions : fallback.instructions,
            nutrition: {
                calories: scraped.nutrition.calories || fallback.nutrition.calories || fallback.calories,
                fat: scraped.nutrition.fat || fallback.nutrition.fat,
                saturatedFat: scraped.nutrition.saturatedFat || fallback.nutrition.saturatedFat,
                carbohydrates: scraped.nutrition.carbohydrates || fallback.nutrition.carbohydrates,
                sugar: scraped.nutrition.sugar || fallback.nutrition.sugar,
                protein: scraped.nutrition.protein || fallback.nutrition.protein,
                fiber: scraped.nutrition.fiber || fallback.nutrition.fiber,
                sodium: scraped.nutrition.sodium || fallback.nutrition.sodium,
            },
            allergens: scraped.allergens.length > 0 ? scraped.allergens : fallback.allergens,
        };
    }
    hasMeaningfulRecipeDetails(details) {
        return (details.ingredients.length > 0 ||
            details.instructions.length > 0 ||
            details.allergens.length > 0 ||
            Object.values(details.nutrition).some((value) => value > 0));
    }
    recipeTags(recipeRecord) {
        return HelloFreshBrowser.asArray(recipeRecord.tags)
            .map((tag) => HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(tag)?.name ?? tag))
            .filter(Boolean);
    }
    parseNutritionInfo(record) {
        const recipe = HelloFreshBrowser.recordValue(record.recipe) ?? record;
        const nutrition = HelloFreshBrowser.recordValue(recipe.nutrition) ??
            HelloFreshBrowser.recordValue(recipe.nutritionPerServing) ??
            HelloFreshBrowser.recordValue(recipe.nutritionFacts) ??
            HelloFreshBrowser.recordValue(recipe.nutritionalValues) ??
            {};
        const nutrientEntries = [
            ...HelloFreshBrowser.asArray(nutrition.items),
            ...HelloFreshBrowser.asArray(nutrition.values),
            ...HelloFreshBrowser.asArray(nutrition.nutrients),
            ...HelloFreshBrowser.asArray(recipe.nutrients),
        ];
        const nutrientValue = (aliases, directValues) => {
            for (const value of directValues) {
                const parsed = HelloFreshBrowser.maybeNumber(value);
                if (parsed !== undefined)
                    return parsed;
            }
            for (const entry of nutrientEntries) {
                const row = HelloFreshBrowser.recordValue(entry);
                if (!row)
                    continue;
                const label = HelloFreshBrowser.stringValue(row.label ?? row.name ?? row.key ?? row.code).toLowerCase();
                if (!aliases.some((alias) => label.includes(alias)))
                    continue;
                const parsed = HelloFreshBrowser.maybeNumber(row.amount ?? row.value ?? row.quantity);
                if (parsed !== undefined)
                    return parsed;
            }
            return 0;
        };
        return {
            calories: nutrientValue(["calorie", "energy", "kcal"], [
                nutrition.calories,
                nutrition.energyKcal,
                nutrition.kcal,
                recipe.calories,
            ]),
            fat: nutrientValue(["fat"], [nutrition.fat, nutrition.totalFat]),
            saturatedFat: nutrientValue(["saturated"], [nutrition.saturatedFat, nutrition.saturates]),
            carbohydrates: nutrientValue(["carb", "carbohydrate"], [
                nutrition.carbohydrate,
                nutrition.carbohydrates,
                nutrition.carbs,
            ]),
            sugar: nutrientValue(["sugar"], [nutrition.sugar, nutrition.sugars]),
            protein: nutrientValue(["protein"], [nutrition.protein]),
            fiber: nutrientValue(["fiber", "fibre"], [nutrition.fiber, nutrition.fibre]),
            sodium: nutrientValue(["sodium", "salt", "natrium"], [nutrition.sodium, nutrition.salt]),
        };
    }
    parseIngredients(record) {
        const recipe = HelloFreshBrowser.recordValue(record.recipe) ?? record;
        const values = [
            ...HelloFreshBrowser.asArray(recipe.ingredients),
            ...HelloFreshBrowser.asArray(recipe.ingredientLines),
            ...HelloFreshBrowser.asArray(recipe.ingredientsWithAlternatives),
            ...HelloFreshBrowser.asArray(recipe.recipeIngredients),
            ...HelloFreshBrowser.asArray(recipe.products),
        ];
        const seen = new Set();
        const ingredients = [];
        for (const value of values) {
            if (typeof value === "string") {
                const name = value.trim();
                if (!name || seen.has(name))
                    continue;
                seen.add(name);
                ingredients.push({ name, amount: "", unit: "" });
                continue;
            }
            const entry = HelloFreshBrowser.recordValue(value);
            if (!entry)
                continue;
            const ingredientRecord = HelloFreshBrowser.recordValue(entry.ingredient) ??
                HelloFreshBrowser.recordValue(entry.product) ??
                HelloFreshBrowser.recordValue(entry.item) ??
                entry;
            const name = HelloFreshBrowser.stringValue(ingredientRecord.name ??
                ingredientRecord.displayName ??
                ingredientRecord.title ??
                entry.name ??
                entry.title).trim();
            if (!name)
                continue;
            const amountValue = entry.amount ??
                entry.quantity ??
                entry.value ??
                ingredientRecord.amount ??
                ingredientRecord.quantity;
            const amount = HelloFreshBrowser.stringValue(amountValue).trim();
            const unit = HelloFreshBrowser.stringValue(entry.unit ??
                entry.unitName ??
                ingredientRecord.unit ??
                ingredientRecord.unitName).trim();
            const key = `${name}|${amount}|${unit}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            ingredients.push({ name, amount, unit });
        }
        return ingredients;
    }
    parseInstructions(record) {
        const recipe = HelloFreshBrowser.recordValue(record.recipe) ?? record;
        const values = [
            ...HelloFreshBrowser.asArray(recipe.instructions),
            ...HelloFreshBrowser.asArray(recipe.steps),
            ...HelloFreshBrowser.asArray(recipe.methodSteps),
            ...HelloFreshBrowser.asArray(recipe.recipeInstructions),
        ];
        const steps = [];
        const seen = new Set();
        for (const value of values) {
            const text = typeof value === "string"
                ? value.trim()
                : HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(value)?.text ??
                    HelloFreshBrowser.recordValue(value)?.description ??
                    HelloFreshBrowser.recordValue(value)?.instruction ??
                    HelloFreshBrowser.recordValue(value)?.body).trim();
            if (!text || seen.has(text))
                continue;
            seen.add(text);
            steps.push(text);
        }
        return steps;
    }
    parseAllergens(record) {
        const recipe = HelloFreshBrowser.recordValue(record.recipe) ?? record;
        const values = [
            ...HelloFreshBrowser.asArray(recipe.allergens),
            ...HelloFreshBrowser.asArray(recipe.allergenInformation),
            ...HelloFreshBrowser.asArray(HelloFreshBrowser.recordValue(recipe.dietaryPreferences)?.allergens),
        ];
        return HelloFreshBrowser.uniqueStrings(values.map((value) => HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(value)?.name ??
            HelloFreshBrowser.recordValue(value)?.label ??
            value)));
    }
    parseUtensils(record) {
        const recipe = HelloFreshBrowser.recordValue(record.recipe) ?? record;
        const values = [
            ...HelloFreshBrowser.asArray(recipe.utensils),
            ...HelloFreshBrowser.asArray(recipe.tools),
            ...HelloFreshBrowser.asArray(recipe.equipment),
        ];
        return HelloFreshBrowser.uniqueStrings(values.map((value) => HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(value)?.name ??
            HelloFreshBrowser.recordValue(value)?.label ??
            value)));
    }
    normalizeDeliveryRecord(record) {
        const nestedDelivery = HelloFreshBrowser.recordValue(record.delivery);
        const weekId = HelloFreshBrowser.stringValue(record.id ??
            record.week ??
            record.hfWeek ??
            record.deliveryWeek ??
            nestedDelivery?.id ??
            nestedDelivery?.week ??
            nestedDelivery?.hfWeek);
        const deliveryDate = HelloFreshBrowser.stringValue(record.deliveryDate ??
            record.delivery_date ??
            record.date ??
            record.deliveredAt ??
            record.expectedDeliveryDate ??
            nestedDelivery?.date ??
            nestedDelivery?.deliveryDate ??
            nestedDelivery?.expectedDeliveryDate);
        const status = HelloFreshBrowser.stringValue(record.status ??
            record.state ??
            nestedDelivery?.status ??
            nestedDelivery?.state ??
            "Scheduled");
        const meals = this.selectedMealsFromUnknownItems(record.recipes ??
            record.meals ??
            record.selectedMeals ??
            record.lineItems ??
            record.items ??
            nestedDelivery?.recipes ??
            nestedDelivery?.meals ??
            nestedDelivery?.selectedMeals ??
            nestedDelivery?.lineItems ??
            nestedDelivery?.items);
        return {
            weekId,
            deliveryDate,
            status,
            meals,
            canModify: this.deliveryCanModify(record, status, deliveryDate),
        };
    }
    deliveryNeedsMenuLookup(delivery) {
        if (delivery.meals.length > 0 || !delivery.weekId)
            return false;
        if (!delivery.deliveryDate)
            return !/delivered|cancelled|skipped/i.test(delivery.status);
        const deliveryTime = Date.parse(delivery.deliveryDate);
        return !Number.isFinite(deliveryTime) || deliveryTime >= Date.now();
    }
    deliveryCanModify(record, status, deliveryDate) {
        const nestedDelivery = HelloFreshBrowser.recordValue(record.delivery);
        const allowedActions = HelloFreshBrowser.recordValue(record.allowedActions) ??
            HelloFreshBrowser.recordValue(nestedDelivery?.allowedActions);
        if (typeof allowedActions?.mealSwap === "boolean")
            return allowedActions.mealSwap;
        const explicitActionable = record.actionable ??
            record.modifiable ??
            nestedDelivery?.actionable ??
            nestedDelivery?.modifiable;
        if (typeof explicitActionable === "boolean")
            return explicitActionable;
        if (/delivered|cancelled|canceled|skipped|paused/i.test(status))
            return false;
        const cutoffText = HelloFreshBrowser.stringValue(record.cutoffDate ??
            record.cutoffDateTime ??
            nestedDelivery?.cutoffDate ??
            nestedDelivery?.cutoffDateTime);
        if (cutoffText) {
            const cutoffTime = Date.parse(cutoffText);
            if (Number.isFinite(cutoffTime) && cutoffTime <= Date.now())
                return false;
        }
        if (deliveryDate) {
            const deliveryTime = Date.parse(deliveryDate);
            if (Number.isFinite(deliveryTime) && deliveryTime <= Date.now())
                return false;
        }
        return true;
    }
    normalizeOrderRecord(record) {
        const nestedDelivery = HelloFreshBrowser.recordValue(record.delivery);
        const orderId = HelloFreshBrowser.stringValue(record.id ??
            record.orderId ??
            record.incrementId ??
            record.number ??
            nestedDelivery?.id);
        const deliveryDate = HelloFreshBrowser.stringValue(record.deliveryDate ??
            record.delivery_date ??
            record.date ??
            record.deliveredAt ??
            record.expectedDeliveryDate ??
            nestedDelivery?.date ??
            nestedDelivery?.deliveryDate ??
            nestedDelivery?.expectedDeliveryDate);
        return {
            orderId,
            deliveryDate,
            meals: this.selectedMealsFromUnknownItems(record.recipes ??
                record.meals ??
                record.selectedMeals ??
                record.lineItems ??
                record.items ??
                record.products ??
                nestedDelivery?.recipes ??
                nestedDelivery?.meals ??
                nestedDelivery?.lineItems ??
                nestedDelivery?.items),
            totalPrice: this.normalizeCurrencyAmount(record.totalPrice ?? record.total ?? record.price ?? record.grandTotal),
            status: HelloFreshBrowser.stringValue(record.status ?? record.state ?? nestedDelivery?.status ?? "Delivered"),
        };
    }
    selectedMealsFromUnknownItems(value) {
        const meals = [];
        const seen = new Set();
        for (const item of HelloFreshBrowser.asArray(value)) {
            const record = HelloFreshBrowser.recordValue(item);
            if (!record) {
                const recipeName = HelloFreshBrowser.stringValue(item).trim();
                if (!recipeName || seen.has(recipeName))
                    continue;
                seen.add(recipeName);
                meals.push({ recipeId: "", recipeName, servings: 2 });
                continue;
            }
            const product = HelloFreshBrowser.recordValue(record.product);
            const source = HelloFreshBrowser.recordValue(record.recipe) ??
                HelloFreshBrowser.recordValue(product?.recipe) ??
                product ??
                HelloFreshBrowser.recordValue(record.meal) ??
                HelloFreshBrowser.recordValue(record.item) ??
                record;
            const recipeId = HelloFreshBrowser.stringValue(source.id ??
                source.recipeId ??
                record.recipeId ??
                record.productId ??
                record.sku);
            const recipeName = HelloFreshBrowser.stringValue(source.name ??
                source.title ??
                record.recipeName ??
                record.name ??
                record.title).trim();
            if (!recipeId && !recipeName)
                continue;
            const servings = HelloFreshBrowser.numberValue(record.servings ??
                record.quantity ??
                record.count ??
                source.servings ??
                source.quantity, 2);
            const key = `${recipeId}|${recipeName}|${servings}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            meals.push({ recipeId, recipeName, servings });
        }
        return meals;
    }
    async getOrderDetailRecord(orderId) {
        const encoded = encodeURIComponent(orderId);
        const paths = [
            `/gw/api/customers/me/orders/${encoded}?country=${encodeURIComponent(this.country)}&locale=${encodeURIComponent(this.locale)}`,
            `/gw/api/customers/me/orders/${encoded}?country=${encodeURIComponent(this.country)}`,
            `/gw/api/customers/me/orders/${encoded}`,
        ];
        let lastError = null;
        for (const path of paths) {
            try {
                return await this.apiGet(path);
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
            }
        }
        throw lastError ?? new Error(`HelloFresh order detail lookup failed for ${orderId}.`);
    }
    normalizeCurrencyAmount(value) {
        const amount = HelloFreshBrowser.numberValue(value, 0);
        return Number.isInteger(amount) && amount >= 100 ? amount / 100 : amount;
    }
    async loadPreferenceApiRecords() {
        const records = [];
        const subscription = await this.getPrimarySubscriptionRecord();
        records.push(subscription);
        const subscriptionCustomer = HelloFreshBrowser.recordValue(subscription.customer);
        if (subscriptionCustomer)
            records.push(subscriptionCustomer);
        const paths = [
            `/gw/api/customers/me?country=${encodeURIComponent(this.country)}&locale=${encodeURIComponent(this.locale)}`,
            `/gw/api/customers/me/profile?country=${encodeURIComponent(this.country)}&locale=${encodeURIComponent(this.locale)}`,
            `/gw/api/customers/me/preferences?country=${encodeURIComponent(this.country)}&locale=${encodeURIComponent(this.locale)}`,
        ];
        for (const path of paths) {
            try {
                const response = await this.apiGet(path);
                const record = HelloFreshBrowser.recordValue(response.customer) ??
                    HelloFreshBrowser.recordValue(response.profile) ??
                    HelloFreshBrowser.recordValue(response.preferences) ??
                    response;
                records.push(record);
            }
            catch {
                // Some regions expose only subscription/customer records.
            }
        }
        return records;
    }
    preferencesFromApiRecords(records) {
        const dietaryPreferences = this.preferenceStrings(records, [
            "dietaryPreferences",
            "dietPreferences",
            "selectedPreferences",
            "preferences",
            "preferenceSelections",
        ]);
        const allergens = this.preferenceStrings(records, [
            "allergens",
            "allergenInformation",
            "allergyPreferences",
            "excludedAllergens",
        ]);
        const cuisinePreferences = this.preferenceStrings(records, [
            "cuisinePreferences",
            "cuisines",
            "preferredCuisines",
        ]);
        const vegetarian = this.preferenceBoolean(records, ["vegetarian", "isVegetarian"]) ||
            dietaryPreferences.some((value) => /vegetarian|veggie|vegetar/i.test(value)) ||
            records.some((record) => /vegetarian|veggie|vegetar/i.test(HelloFreshBrowser.stringValue(record.preset)));
        const familyFriendly = this.preferenceBoolean(records, ["familyFriendly", "isFamilyFriendly"]) ||
            dietaryPreferences.some((value) => /family|familie/i.test(value));
        const calorieGoal = this.preferenceNumber(records, [
            "calorieGoal",
            "caloriePreference",
            "calories",
            "targetCalories",
        ]);
        if (dietaryPreferences.length === 0 &&
            allergens.length === 0 &&
            cuisinePreferences.length === 0 &&
            !vegetarian &&
            !familyFriendly &&
            calorieGoal === undefined) {
            return null;
        }
        return {
            dietaryPreferences: dietaryPreferences.filter((value) => !/vegetarian|veggie|vegetar|family|familie/i.test(value)),
            allergens,
            cuisinePreferences,
            familyFriendly,
            vegetarian,
            calorieGoal,
        };
    }
    preferenceStrings(records, keys) {
        return HelloFreshBrowser.uniqueStrings(records.flatMap((record) => this.preferenceFieldValues(record, keys).flatMap((value) => this.collectPreferenceStrings(value))));
    }
    preferenceBoolean(records, keys) {
        return records.some((record) => this.preferenceFieldValues(record, keys).some((value) => {
            if (typeof value === "boolean")
                return value;
            const text = HelloFreshBrowser.stringValue(value).trim().toLowerCase();
            return text === "true" || text === "yes";
        }));
    }
    preferenceNumber(records, keys) {
        for (const record of records) {
            for (const value of this.preferenceFieldValues(record, keys)) {
                const parsed = HelloFreshBrowser.maybeNumber(value);
                if (parsed !== undefined)
                    return parsed;
            }
        }
        return undefined;
    }
    preferenceFieldValues(record, keys) {
        const containers = [
            record,
            HelloFreshBrowser.recordValue(record.preferences),
            HelloFreshBrowser.recordValue(record.profile),
            HelloFreshBrowser.recordValue(record.customer),
            HelloFreshBrowser.recordValue(record.attributes),
            HelloFreshBrowser.recordValue(record.data),
        ].filter((value) => Boolean(value));
        const values = [];
        for (const container of containers) {
            for (const key of keys) {
                if (key in container) {
                    values.push(container[key]);
                }
            }
        }
        return values;
    }
    collectPreferenceStrings(value) {
        if (typeof value === "string") {
            const text = value.trim();
            return text ? [text] : [];
        }
        if (Array.isArray(value)) {
            return value.flatMap((item) => this.collectPreferenceStrings(item));
        }
        const record = HelloFreshBrowser.recordValue(value);
        if (!record)
            return [];
        if (record.selected === false || record.enabled === false || record.active === false) {
            return [];
        }
        const named = HelloFreshBrowser.stringValue(record.name ?? record.label ?? record.title ?? record.value).trim();
        if (named)
            return [named];
        return [
            ...this.collectPreferenceStrings(record.items),
            ...this.collectPreferenceStrings(record.values),
            ...this.collectPreferenceStrings(record.options),
        ];
    }
    async scrapePreferencesFromPage() {
        const page = await this.ensurePage();
        await page.goto(`${this.baseUrl}/my-account/preferences`, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
        const preferences = await page.evaluate(() => {
            const checkedPrefs = Array.from(document.querySelectorAll('input[type="checkbox"]:checked, [data-testid*="preference"][aria-checked="true"]')).map((el) => el.getAttribute("value") ||
                el.getAttribute("name") ||
                el.value ||
                "");
            const lower = checkedPrefs.map((pref) => pref.toLowerCase());
            return {
                dietaryPreferences: checkedPrefs.filter((pref) => !pref.toLowerCase().includes("allergen") && !pref.toLowerCase().includes("cuisine")),
                allergens: checkedPrefs.filter((pref) => pref.toLowerCase().includes("allergen")),
                cuisinePreferences: checkedPrefs.filter((pref) => pref.toLowerCase().includes("cuisine")),
                familyFriendly: lower.some((pref) => pref.includes("family") || pref.includes("familie")),
                vegetarian: lower.some((pref) => pref.includes("vegetarian") || pref.includes("veggie") || pref.includes("vegetar")),
            };
        });
        const hasSignals = preferences.dietaryPreferences.length > 0 ||
            preferences.allergens.length > 0 ||
            preferences.cuisinePreferences.length > 0 ||
            preferences.familyFriendly ||
            preferences.vegetarian;
        return hasSignals ? preferences : null;
    }
    async captureBrowserSession() {
        if (!this.context)
            throw new Error("Browser context is not initialized.");
        const cookies = await this.context.cookies(this.baseUrl);
        const authCookie = cookies.find((cookie) => cookie.name === "apiV2Auth");
        if (!authCookie?.value) {
            throw new Error("HelloFresh session does not contain an API auth token.");
        }
        const auth = HelloFreshBrowser.parseAuthCookie(authCookie.value);
        const session = {
            auth,
            cookies: cookies.map((cookie) => ({
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                expires: cookie.expires,
            })),
            savedAt: Date.now(),
        };
        this.apiSession = session;
        await this.saveSession(session);
    }
    async apiGet(path) {
        return this.apiRequest(path);
    }
    async apiRequest(path, init = {}) {
        await this.ensureApiSession();
        const response = await this.apiFetch(path, init);
        if (response.status === 401 && (await this.refreshApiSession())) {
            const retry = await this.apiFetch(path, init);
            return this.parseApiResponse(retry);
        }
        return this.parseApiResponse(response);
    }
    async apiFetch(path, init = {}) {
        if (!this.apiSession)
            throw new Error("HelloFresh API session is not initialized.");
        const url = new URL(path, this.baseUrl).toString();
        const headers = new Headers(init.headers);
        headers.set("Accept", "application/json");
        headers.set("Authorization", `${this.apiSession.auth.token_type || "Bearer"} ${this.apiSession.auth.access_token}`);
        headers.set("Cookie", this.cookieHeader());
        headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        headers.set("Referer", `${this.baseUrl}/menu`);
        headers.set("Origin", this.baseUrl);
        return this.fetchWithTimeout(url, path, { ...init, headers });
    }
    async fetchWithTimeout(url, path, init = {}) {
        const controller = init.signal ? null : new AbortController();
        const timeout = controller
            ? setTimeout(() => controller.abort(), this.apiTimeoutMs)
            : undefined;
        try {
            return await fetch(url, {
                ...init,
                signal: init.signal ?? controller?.signal,
            });
        }
        catch (error) {
            if (controller && error instanceof Error && error.name === "AbortError") {
                throw new Error(`HelloFresh API request timed out after ${this.apiTimeoutMs}ms: ${path}`);
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`HelloFresh API request failed for ${path}: ${message}`);
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
        }
    }
    async parseApiResponse(response) {
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`HelloFresh API ${response.status}: ${text.slice(0, 300)}`);
        }
        return (text ? JSON.parse(text) : null);
    }
    async ensureApiSession() {
        if (this.apiSession && !HelloFreshBrowser.isAccessTokenExpired(this.apiSession.auth))
            return;
        const storedSession = this.apiSession ?? (await this.loadSession());
        if (!storedSession) {
            throw new Error("HelloFresh API session is not initialized.");
        }
        this.apiSession = storedSession;
        if (HelloFreshBrowser.isAccessTokenExpired(storedSession.auth)) {
            const refreshed = await this.refreshApiSession();
            if (!refreshed) {
                throw new Error("HelloFresh API session expired and could not be refreshed.");
            }
        }
    }
    async activateStoredSession(session) {
        this.apiSession = session;
        if (HelloFreshBrowser.isRefreshTokenExpired(session.auth))
            return false;
        if (!HelloFreshBrowser.isAccessTokenExpired(session.auth))
            return true;
        return this.refreshApiSession();
    }
    async refreshApiSession() {
        if (!this.apiSession?.auth.refresh_token)
            return false;
        if (HelloFreshBrowser.isRefreshTokenExpired(this.apiSession.auth))
            return false;
        const refreshPath = `/gw/refresh?locale=${encodeURIComponent(this.locale)}&country=${encodeURIComponent(this.country)}`;
        const response = await this.fetchWithTimeout(new URL(refreshPath, this.baseUrl), refreshPath, {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Cookie": this.cookieHeader(),
                "Origin": this.baseUrl,
                "Referer": `${this.baseUrl}/menu`,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            body: JSON.stringify({ refresh_token: this.apiSession.auth.refresh_token }),
        });
        if (!response.ok)
            return false;
        const auth = (await response.json());
        this.apiSession = {
            auth,
            cookies: this.upsertAuthCookie(this.apiSession.cookies, auth),
            savedAt: Date.now(),
        };
        await this.saveSession(this.apiSession);
        return true;
    }
    async loadSession() {
        try {
            const raw = await (0, promises_1.readFile)(this.sessionPath, "utf8");
            const session = JSON.parse(raw);
            if (!session.auth?.access_token || !Array.isArray(session.cookies))
                return null;
            this.apiSession = session;
            return session;
        }
        catch {
            return null;
        }
    }
    async saveSession(session) {
        await (0, promises_1.mkdir)((0, node_path_1.dirname)(this.sessionPath), { recursive: true, mode: 0o700 });
        await (0, promises_1.writeFile)(this.sessionPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
        await (0, promises_1.chmod)(this.sessionPath, 0o600).catch(() => { });
    }
    cookieHeader() {
        if (!this.apiSession)
            return "";
        const nowSeconds = Date.now() / 1000;
        return this.apiSession.cookies
            .filter((cookie) => !cookie.expires || cookie.expires < 0 || cookie.expires > nowSeconds)
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; ");
    }
    upsertAuthCookie(cookies, auth) {
        const encoded = encodeURIComponent(JSON.stringify(auth));
        const next = cookies.filter((cookie) => cookie.name !== "apiV2Auth");
        next.push({
            name: "apiV2Auth",
            value: encoded,
            domain: new URL(this.baseUrl).hostname,
            path: "/",
            expires: HelloFreshBrowser.authExpirySeconds(auth),
        });
        return next;
    }
    async getPrimarySubscriptionRecord() {
        const data = await this.apiGet(`/gw/api/customers/me/subscriptions?country=${encodeURIComponent(this.country)}`);
        const subscriptions = HelloFreshBrowser.asArray(data.items ?? data.subscriptions ?? data);
        const active = subscriptions.find((subscription) => subscription.isActive !== false && !subscription.canceledAt);
        const subscription = (active ?? subscriptions[0]);
        if (!subscription)
            throw new Error("No HelloFresh subscription found for this account.");
        return subscription;
    }
    async getDeliveryRecords(rangeWeeks) {
        const start = HelloFreshBrowser.isoWeekOffset(-2);
        const end = HelloFreshBrowser.isoWeekOffset(rangeWeeks);
        const data = await this.apiGet(`/gw/api/customers/me/deliveries?country=${encodeURIComponent(this.country)}&locale=${encodeURIComponent(this.locale)}&rangeEnd=${encodeURIComponent(end)}&rangeStart=${encodeURIComponent(start)}`);
        return HelloFreshBrowser.asArray(data.items ?? data.deliveries).map((item) => HelloFreshBrowser.recordValue(item) ?? {});
    }
    async buildMealSelectionPlan(weekId, mealSelections) {
        const subscription = await this.getPrimarySubscriptionRecord();
        const delivery = await this.getDeliveryByWeek(subscription, weekId);
        const menu = await this.apiGet(this.buildMenuApiPath(subscription, weekId));
        const menuMeals = HelloFreshBrowser.asArray(menu.meals)
            .map((meal) => HelloFreshBrowser.recordValue(meal))
            .filter((meal) => Boolean(meal));
        const currentMeals = this.selectedMealsFromMenu(menu);
        const resolvedMeals = this.resolveMealSelections(menuMeals, mealSelections, weekId);
        const requestedMeals = resolvedMeals.map((meal) => ({
            recipeId: meal.recipeId,
            recipeName: meal.name,
            servings: meal.quantity,
        }));
        const requestedMealCount = resolvedMeals.reduce((total, meal) => total + meal.quantity, 0);
        const product = HelloFreshBrowser.recordValue(subscription.product);
        const specs = HelloFreshBrowser.recordValue(product?.specs);
        const expectedMealCount = HelloFreshBrowser.numberValue(specs?.meals, requestedMealCount);
        const reason = this.mealSelectionBlockReason(delivery, weekId, expectedMealCount, requestedMealCount);
        const mutationPath = this.buildCartMutationPath(subscription, delivery, weekId);
        const mutationBody = {
            extras: this.buildAddonSelections(menu),
            meals: resolvedMeals.map((meal) => ({ index: meal.index, quantity: meal.quantity })),
        };
        const price = reason
            ? undefined
            : await this.previewMealSelectionPrice(subscription, delivery, weekId, resolvedMeals).catch(() => undefined);
        const preview = {
            weekId,
            canSelect: !reason,
            reason,
            expectedMealCount,
            requestedMealCount,
            currentMeals,
            requestedMeals,
            addedMeals: HelloFreshBrowser.diffMeals(requestedMeals, currentMeals),
            removedMeals: HelloFreshBrowser.diffMeals(currentMeals, requestedMeals),
            price,
        };
        return {
            subscription,
            delivery,
            menu,
            resolvedMeals,
            currentMeals,
            expectedMealCount,
            requestedMealCount,
            mutationPath,
            mutationBody,
            preview,
        };
    }
    resolveMealSelections(menuMeals, mealSelections, weekId) {
        const requestedById = new Map();
        for (const selection of mealSelections) {
            requestedById.set(selection.recipeId, (requestedById.get(selection.recipeId) ?? 0) + 1);
        }
        return Array.from(requestedById.entries()).map(([recipeId, quantity]) => {
            const menuMeal = menuMeals.find((meal) => {
                const recipe = HelloFreshBrowser.recordValue(meal.recipe);
                return (HelloFreshBrowser.stringValue(recipe?.id) === recipeId ||
                    HelloFreshBrowser.stringValue(meal.index) === recipeId);
            });
            if (!menuMeal) {
                throw new Error(`Recipe ${recipeId} is not available for week ${weekId}.`);
            }
            return {
                recipeId: HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(menuMeal.recipe)?.id),
                index: HelloFreshBrowser.numberValue(menuMeal.index, 0),
                quantity,
                name: HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(menuMeal.recipe)?.name),
            };
        });
    }
    mealSelectionBlockReason(delivery, weekId, expectedMealCount, requestedMealCount) {
        const status = HelloFreshBrowser.stringValue(delivery.status ?? delivery.state).toUpperCase();
        if (status === "PAUSED")
            return `Week ${weekId} is paused. Refusing to unpause it implicitly before selecting meals.`;
        const cutoffText = HelloFreshBrowser.stringValue(delivery.cutoffDate ?? delivery.cutoffDateTime);
        if (cutoffText) {
            const cutoffTime = Date.parse(cutoffText);
            if (Number.isFinite(cutoffTime) && cutoffTime <= Date.now()) {
                return `Week ${weekId} is past its cutoff time and cannot be changed.`;
            }
        }
        const allowedActions = HelloFreshBrowser.recordValue(delivery.allowedActions);
        if (allowedActions && allowedActions.mealSwap === false) {
            return `Week ${weekId} is not currently modifiable for meal selection.`;
        }
        if (expectedMealCount > 0 && requestedMealCount !== expectedMealCount) {
            return `Week ${weekId} requires exactly ${expectedMealCount} meals; received ${requestedMealCount}.`;
        }
        return undefined;
    }
    selectedMealsFromMenu(menu) {
        return this.selectedMealsFromMealRecords(this.selectedMealRecords(menu));
    }
    selectedMealRecords(menu) {
        return HelloFreshBrowser.asArray(menu.meals)
            .map((meal) => HelloFreshBrowser.recordValue(meal))
            .filter((meal) => Boolean(meal?.selection));
    }
    selectedMealsFromMealRecords(meals) {
        return meals.map((meal) => {
            const recipe = HelloFreshBrowser.recordValue(meal.recipe);
            const selection = HelloFreshBrowser.recordValue(meal.selection);
            return {
                recipeId: HelloFreshBrowser.stringValue(recipe?.id),
                recipeName: HelloFreshBrowser.stringValue(recipe?.name),
                servings: HelloFreshBrowser.numberValue(selection?.quantity, 1),
            };
        });
    }
    mealRecordsForResolvedSelections(menu, resolvedMeals) {
        const wantedIndexes = new Set(resolvedMeals.map((meal) => meal.index));
        return HelloFreshBrowser.asArray(menu.meals)
            .map((meal) => HelloFreshBrowser.recordValue(meal))
            .filter((meal) => meal !== undefined && wantedIndexes.has(HelloFreshBrowser.numberValue(meal.index, 0)))
            .map((meal) => ({
            ...meal,
            selection: {
                quantity: resolvedMeals.find((resolved) => resolved.index === HelloFreshBrowser.numberValue(meal.index, 0))?.quantity ?? 1,
            },
        }));
    }
    buildCartMutationPath(subscription, delivery, weekId) {
        const product = HelloFreshBrowser.recordValue(subscription.product);
        const params = new URLSearchParams({
            customer: HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(subscription.customer)?.id),
            cutoff_time: HelloFreshBrowser.stringValue(delivery.cutoffDate ?? delivery.cutoffDateTime),
            ignore_addons: "false",
            preference: HelloFreshBrowser.stringValue(subscription.preset ?? "chefschoice"),
            "product-sku": HelloFreshBrowser.stringValue(product?.sku ?? product?.handle),
            subscription: HelloFreshBrowser.stringValue(subscription.id),
            update_quantity: "true",
            week: weekId,
        });
        return `/gw/v1/carts/${encodeURIComponent(weekId)}?${params.toString()}`;
    }
    async previewMealSelectionPrice(subscription, delivery, weekId, meals) {
        const product = HelloFreshBrowser.recordValue(subscription.product);
        const specs = HelloFreshBrowser.recordValue(product?.specs);
        const address = HelloFreshBrowser.recordValue(subscription.shippingAddress);
        const deliveryOption = HelloFreshBrowser.recordValue(delivery.deliveryOption) ??
            HelloFreshBrowser.recordValue(subscription.deliveryOption);
        const body = {
            boxSize: HelloFreshBrowser.numberValue(specs?.size, 2),
            isFirstOrder: false,
            customerID: HelloFreshBrowser.numberValue(HelloFreshBrowser.recordValue(subscription.customer)?.id, 0),
            isRecurring: true,
            subscriptionID: HelloFreshBrowser.numberValue(subscription.id, 0),
            planID: HelloFreshBrowser.stringValue(subscription.customerPlanId),
            products: [
                {
                    handle: HelloFreshBrowser.stringValue(product?.sku ?? product?.handle),
                    deliveryOption: HelloFreshBrowser.stringValue(deliveryOption?.handle),
                    hfWeek: weekId,
                    unitPrice: HelloFreshBrowser.numberValue(product?.unitPrice, 0) / 100,
                },
                {
                    boxSku: HelloFreshBrowser.stringValue(product?.sku ?? product?.handle),
                    handle: `${this.country}-CHARGE-0-0-0`,
                    hfWeek: weekId,
                    quantityPerCourse: meals.map((meal) => ({ index: meal.index, quantity: meal.quantity })),
                    recipeIndexes: meals.map((meal) => String(meal.index)),
                },
            ],
            shippingAddress: {
                address1: HelloFreshBrowser.stringValue(address?.address1),
                postcode: HelloFreshBrowser.stringValue(address?.postcode),
            },
            locale: this.locale,
            country: this.country,
        };
        const response = await this.apiRequest(`/gw/v1/carts/${encodeURIComponent(weekId)}/price?isFutureWeek=false`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const chargeProduct = HelloFreshBrowser.asArray(response.products)
            .map((item) => HelloFreshBrowser.recordValue(item))
            .find((item) => HelloFreshBrowser.asArray(item?.charges).length > 0);
        const charges = HelloFreshBrowser.asArray(chargeProduct?.charges)
            .map((charge) => HelloFreshBrowser.recordValue(charge))
            .filter((charge) => Boolean(charge))
            .map((charge) => ({
            recipeId: HelloFreshBrowser.stringValue(charge.entity_id),
            amount: HelloFreshBrowser.numberValue(charge.amount, 0) / 100,
            reason: HelloFreshBrowser.stringValue(charge.reason),
        }));
        return {
            subtotal: HelloFreshBrowser.numberValue(response.subTotal, 0),
            shipping: HelloFreshBrowser.numberValue(response.shippingAmount, 0),
            premiumCharges: charges.reduce((total, charge) => total + charge.amount, 0),
            grandTotal: HelloFreshBrowser.numberValue(response.grandTotal, 0),
            charges,
        };
    }
    async getDeliveryByWeek(subscription, weekId) {
        const subscriptionId = HelloFreshBrowser.stringValue(subscription.id);
        if (subscriptionId) {
            try {
                return await this.apiGet(`/gw/api/subscriptions/${encodeURIComponent(subscriptionId)}/delivery_dates/${encodeURIComponent(weekId)}?country=${encodeURIComponent(this.country)}&locale=${encodeURIComponent(this.locale)}`);
            }
            catch {
                // Fall back to the deliveries collection below; some weeks are only present there.
            }
        }
        const deliveries = await this.getDeliveryRecords(12);
        const delivery = deliveries.find((record) => HelloFreshBrowser.stringValue(record.id ?? record.week ?? record.hfWeek) === weekId);
        if (!delivery)
            throw new Error(`Delivery week ${weekId} was not found on this account.`);
        return delivery;
    }
    async getMenuWeek(subscription, weekOffset) {
        const baseWeek = HelloFreshBrowser.stringValue(subscription.nextModifiableDeliveryWeek ?? subscription.nextDeliveryWeek);
        if (baseWeek)
            return HelloFreshBrowser.addIsoWeeks(baseWeek, weekOffset);
        const deliveries = await this.getDeliveryRecords(weekOffset + 8);
        const candidates = deliveries.filter((delivery) => delivery.id || delivery.week);
        const selected = candidates[Math.min(weekOffset, Math.max(candidates.length - 1, 0))];
        const week = HelloFreshBrowser.stringValue(selected?.id ?? selected?.week);
        if (!week)
            throw new Error("Unable to determine a menu week from the HelloFresh account.");
        return week;
    }
    buildMenuApiPath(subscription, week) {
        const product = HelloFreshBrowser.recordValue(subscription.product);
        const productType = HelloFreshBrowser.recordValue(subscription.productType);
        const specs = HelloFreshBrowser.recordValue(product?.specs) ?? HelloFreshBrowser.recordValue(productType?.specs);
        const address = HelloFreshBrowser.recordValue(subscription.shippingAddress);
        const deliveryOption = HelloFreshBrowser.recordValue(subscription.deliveryOption ?? subscription.nextDeliveryOption);
        const params = new URLSearchParams({
            "customerPlanId": HelloFreshBrowser.stringValue(subscription.customerPlanId),
            "delivery-option": HelloFreshBrowser.stringValue(deliveryOption?.handle ?? subscription.nextDeliveryTime ?? subscription.deliveryTime),
            exclude: "",
            "exclude-feedback": "true",
            "include-filters": "true",
            "include-future-feedback": "false",
            locale: this.locale,
            postcode: HelloFreshBrowser.stringValue(address?.postcode),
            preference: HelloFreshBrowser.stringValue(subscription.preset ?? "chefschoice"),
            "product-sku": HelloFreshBrowser.stringValue(product?.sku ?? product?.handle ?? productType?.handle),
            servings: String(HelloFreshBrowser.numberValue(specs?.size, 2)),
            subscription: HelloFreshBrowser.stringValue(subscription.id),
            week,
        });
        return `/gw/my-deliveries/menu?${params.toString()}`;
    }
    buildAddonSelections(menu) {
        const addOns = HelloFreshBrowser.recordValue(menu.addOns);
        return HelloFreshBrowser.asArray(addOns?.groups)
            .map((group) => HelloFreshBrowser.recordValue(group))
            .filter((group) => Boolean(group))
            .map((group) => ({
            groupType: HelloFreshBrowser.stringValue(group.groupType),
            sku: HelloFreshBrowser.stringValue(group.sku),
            selection: HelloFreshBrowser.asArray(group.addOns)
                .map((addOn) => HelloFreshBrowser.recordValue(addOn))
                .filter((addOn) => Boolean(addOn))
                .map((addOn) => {
                const selection = HelloFreshBrowser.recordValue(addOn.selection);
                return {
                    index: HelloFreshBrowser.numberValue(addOn.index, 0),
                    oneOffQuantity: HelloFreshBrowser.numberValue(selection?.oneOffQuantity, 0),
                    preselectedQuantity: HelloFreshBrowser.numberValue(selection?.preselectedQuantity, 0),
                    courses: HelloFreshBrowser.asArray(selection?.courses),
                };
            }),
        }));
    }
    addonCatalog(menu) {
        const catalog = new Map();
        for (const group of HelloFreshBrowser.asArray(HelloFreshBrowser.recordValue(menu.addOns)?.groups)) {
            const groupRecord = HelloFreshBrowser.recordValue(group);
            if (!groupRecord)
                continue;
            for (const addOn of HelloFreshBrowser.asArray(groupRecord.addOns)) {
                const addOnRecord = HelloFreshBrowser.recordValue(addOn);
                if (!addOnRecord)
                    continue;
                const recipe = HelloFreshBrowser.recordValue(addOnRecord.recipe);
                const quantityOption = HelloFreshBrowser.asArray(addOnRecord.quantityOptions)
                    .map((option) => HelloFreshBrowser.recordValue(option))
                    .find((option) => option?.quantity === 1 && option?.people === 2);
                const priceCatalog = HelloFreshBrowser.recordValue(addOnRecord.priceCatalog);
                catalog.set(HelloFreshBrowser.numberValue(addOnRecord.index, 0), {
                    name: HelloFreshBrowser.stringValue(recipe?.name),
                    price: HelloFreshBrowser.numberValue(quantityOption?.totalAmount ?? priceCatalog?.basePrice, 0) / 100,
                });
            }
        }
        return catalog;
    }
    selectAddonForCourse(extras, addonIndex, courseIndex, quantity = 1) {
        for (const group of extras) {
            const selection = group.selection.find((item) => item.index === addonIndex);
            if (!selection)
                continue;
            selection.oneOffQuantity = Math.max(selection.oneOffQuantity, quantity);
            if (!selection.courses.some((course) => HelloFreshBrowser.recordValue(course)?.index === courseIndex)) {
                selection.courses.push({ index: courseIndex });
            }
            return;
        }
    }
    recommendedExtrasFromMenu(menu, meals) {
        const addonCatalog = this.addonCatalog(menu);
        const selectedIndexes = new Map(meals.map((meal) => [
            HelloFreshBrowser.numberValue(meal.index, 0),
            {
                mealName: HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(meal.recipe)?.name),
                mealRecipeId: HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(meal.recipe)?.id),
            },
        ]));
        return HelloFreshBrowser.asArray(menu.modularity)
            .map((module) => HelloFreshBrowser.recordValue(module))
            .filter((module) => Boolean(module))
            .map((module) => {
            const mealIndex = HelloFreshBrowser.numberValue(module.defaultCourseIndex, 0);
            const meal = selectedIndexes.get(mealIndex);
            if (!meal)
                return null;
            return {
                mealIndex,
                mealRecipeId: meal.mealRecipeId,
                mealName: meal.mealName,
                headline: HelloFreshBrowser.stringValue(module.addOnsHeadline),
                options: HelloFreshBrowser.asArray(module.addOns)
                    .map((addOn) => HelloFreshBrowser.recordValue(addOn))
                    .filter((addOn) => Boolean(addOn))
                    .map((addOn) => {
                    const addonIndex = HelloFreshBrowser.numberValue(addOn.index, 0);
                    const catalog = addonCatalog.get(addonIndex);
                    return catalog
                        ? { addonIndex, addonName: catalog.name, price: catalog.price }
                        : null;
                })
                    .filter((option) => Boolean(option)),
            };
        })
            .filter((option) => Boolean(option));
    }
    weekMenuMealsFromMenu(menu) {
        const addonCatalog = this.addonCatalog(menu);
        const modularityByMealIndex = new Map(HelloFreshBrowser.asArray(menu.modularity)
            .map((module) => HelloFreshBrowser.recordValue(module))
            .filter((module) => Boolean(module))
            .map((module) => [HelloFreshBrowser.numberValue(module.defaultCourseIndex, 0), module]));
        return HelloFreshBrowser.asArray(menu.meals)
            .map((meal) => HelloFreshBrowser.recordValue(meal))
            .filter((meal) => Boolean(meal))
            .map((meal) => {
            const parsed = this.parseApiRecipes([meal])[0];
            if (!parsed) {
                throw new Error(`Unable to parse week menu meal ${HelloFreshBrowser.numberValue(meal.index, 0)}.`);
            }
            const recipe = HelloFreshBrowser.recordValue(meal.recipe);
            const nutrition = HelloFreshBrowser.recordValue(recipe?.nutrition);
            const module = modularityByMealIndex.get(HelloFreshBrowser.numberValue(meal.index, 0));
            const cuisines = HelloFreshBrowser.asArray(recipe?.cuisines)
                .map((cuisine) => HelloFreshBrowser.recordValue(cuisine))
                .filter((cuisine) => Boolean(cuisine))
                .map((cuisine) => HelloFreshBrowser.stringValue(cuisine.name));
            const labelRecord = HelloFreshBrowser.recordValue(recipe?.label);
            const label = HelloFreshBrowser.optionalString(labelRecord?.text ?? labelRecord?.name ?? labelRecord?.title ?? recipe?.label);
            const nutritionPerServing = nutrition
                ? {
                    kcal: HelloFreshBrowser.numberValue(nutrition.calories, 0),
                    carbs_g: HelloFreshBrowser.numberValue(nutrition.carbohydrate, 0),
                    protein_g: HelloFreshBrowser.numberValue(nutrition.protein, 0),
                    fat_g: HelloFreshBrowser.numberValue(nutrition.fat, 0),
                }
                : undefined;
            return {
                ...parsed,
                menuIndex: HelloFreshBrowser.numberValue(meal.index, 0),
                selected: Boolean(meal.selection),
                nutritionPerServing,
                mealOptions: module
                    ? {
                        recommendedExtrasHeadline: HelloFreshBrowser.stringValue(module.addOnsHeadline),
                        recommendedExtras: HelloFreshBrowser.asArray(module.addOns)
                            .map((addOn) => HelloFreshBrowser.recordValue(addOn))
                            .filter((addOn) => Boolean(addOn))
                            .map((addOn) => {
                            const addonIndex = HelloFreshBrowser.numberValue(addOn.index, 0);
                            const catalog = addonCatalog.get(addonIndex);
                            return {
                                addonIndex,
                                title: HelloFreshBrowser.stringValue(addOn.title) ||
                                    HelloFreshBrowser.stringValue(catalog?.name),
                                price: catalog?.price,
                            };
                        }),
                        variations: HelloFreshBrowser.asArray(module.variations)
                            .map((variation) => HelloFreshBrowser.recordValue(variation))
                            .filter((variation) => Boolean(variation))
                            .map((variation) => ({
                            variationIndex: HelloFreshBrowser.numberValue(variation.index, 0),
                            title: HelloFreshBrowser.stringValue(variation.title) ||
                                HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(variation.ingredient)?.name),
                        })),
                    }
                    : undefined,
                display: {
                    title: parsed.name,
                    subtitle: parsed.description,
                    imageUrl: parsed.imageUrl,
                    expectedCookingTimeMinutes: parsed.totalTime,
                    categories: HelloFreshBrowser.uniqueStrings([
                        parsed.cuisineType,
                        label,
                        ...cuisines,
                    ]),
                    badges: HelloFreshBrowser.uniqueStrings(parsed.tags),
                    nutritionPerServing,
                    selected: Boolean(meal.selection),
                },
            };
        });
    }
    resolveExtraSelections(meals, menu, extraSelections) {
        const mealByIndex = new Map(meals.map((meal) => [
            HelloFreshBrowser.numberValue(meal.index, 0),
            {
                recipeId: HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(meal.recipe)?.id),
                mealName: HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(meal.recipe)?.name),
            },
        ]));
        const mealIndexByRecipeId = new Map(Array.from(mealByIndex.entries()).map(([mealIndex, meal]) => [meal.recipeId, mealIndex]));
        const addonCatalog = this.addonCatalog(menu);
        return extraSelections.map((selection) => {
            const mealIndex = selection.mealIndex ??
                (selection.mealRecipeId ? mealIndexByRecipeId.get(selection.mealRecipeId) : undefined);
            if (!mealIndex || !mealByIndex.has(mealIndex)) {
                throw new Error(`Extra selection ${selection.addonIndex} does not target a currently selected meal.`);
            }
            const addon = addonCatalog.get(selection.addonIndex);
            if (!addon) {
                throw new Error(`Addon ${selection.addonIndex} is not available for week extras.`);
            }
            return {
                mealIndex,
                mealName: mealByIndex.get(mealIndex).mealName,
                addonIndex: selection.addonIndex,
                addonName: addon.name,
                price: addon.price,
                quantity: selection.quantity ?? 1,
            };
        });
    }
    selectedAddons(menu) {
        const selected = [];
        for (const group of HelloFreshBrowser.asArray(HelloFreshBrowser.recordValue(menu.addOns)?.groups)) {
            const groupRecord = HelloFreshBrowser.recordValue(group);
            if (!groupRecord)
                continue;
            for (const addOn of HelloFreshBrowser.asArray(groupRecord.addOns)) {
                const addOnRecord = HelloFreshBrowser.recordValue(addOn);
                const selection = HelloFreshBrowser.recordValue(addOnRecord?.selection);
                if (!addOnRecord || !selection)
                    continue;
                if (HelloFreshBrowser.numberValue(selection.oneOffQuantity, 0) > 0 ||
                    HelloFreshBrowser.numberValue(selection.preselectedQuantity, 0) > 0 ||
                    HelloFreshBrowser.asArray(selection.courses).length > 0) {
                    selected.push({
                        addonIndex: HelloFreshBrowser.numberValue(addOnRecord.index, 0),
                        addonName: HelloFreshBrowser.stringValue(HelloFreshBrowser.recordValue(addOnRecord.recipe)?.name),
                    });
                }
            }
        }
        return selected;
    }
    async scrapeRecipesFromCurrentPage() {
        const page = await this.ensurePage();
        return page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('[data-testid*="recipe"], [data-test-id*="recipe"], [class*="RecipeCard"], [class*="recipe-card"], article'));
            const seen = new Set();
            return cards
                .map((card) => {
                const name = card.querySelector('h1, h2, h3, [data-testid*="name"], [class*="Name"], [class*="Title"]')?.textContent?.trim() ?? "";
                const link = card.querySelector('a[href*="/recipes/"]')?.href;
                const id = card.getAttribute("data-recipe-id") || card.getAttribute("data-id") || link?.split("-").pop() || "";
                const text = card.textContent ?? "";
                const time = Number.parseInt(text.match(/(\d+)\s*(min|minutes)/i)?.[1] ?? "0", 10) || 0;
                const calories = Number.parseInt(text.match(/(\d+)\s*kcal/i)?.[1] ?? "0", 10) || 0;
                const image = card.querySelector("img")?.src;
                return {
                    id,
                    name,
                    description: "",
                    imageUrl: image,
                    prepTime: Math.min(time || 40, 10),
                    cookTime: Math.max((time || 40) - 10, 0),
                    totalTime: time || 40,
                    difficulty: "Medium",
                    calories,
                    servings: 2,
                    tags: [],
                    isVegetarian: /vegetarian|veggie|vegetar/i.test(text),
                    isFamily: /family|familie/i.test(text),
                };
            })
                .filter((recipe) => {
                if (!recipe.id || !recipe.name || seen.has(recipe.id))
                    return false;
                seen.add(recipe.id);
                return true;
            });
        });
    }
    async scrapeDeliveryScheduleFromCurrentPage(navigationTimeoutMs = 20_000) {
        const page = await this.ensurePage();
        await page.goto(`${this.baseUrl}/my-account/deliveries`, {
            waitUntil: "domcontentloaded",
            timeout: navigationTimeoutMs,
        });
        await page.waitForLoadState("networkidle", { timeout: navigationTimeoutMs }).catch(() => { });
        return page.evaluate(() => Array.from(document.querySelectorAll('[data-testid*="delivery"], [class*="DeliveryCard"], [class*="delivery-card"], article')).map((el) => ({
            weekId: el.getAttribute("data-week") || el.getAttribute("data-delivery-id") || "",
            deliveryDate: el.querySelector('[class*="date"], [data-testid*="date"]')?.textContent?.trim() || "",
            status: el.querySelector('[class*="status"], [data-testid*="status"]')?.textContent?.trim() || "Scheduled",
            meals: Array.from(el.querySelectorAll('[class*="meal"], [class*="recipe"]')).map((meal) => ({
                recipeId: meal.getAttribute("data-recipe-id") || "",
                recipeName: meal.textContent?.trim() || "",
                servings: 2,
            })),
            canModify: /modify|change|wijzig|aanpassen/i.test(el.textContent ?? ""),
        })));
    }
    async scrapeSubscriptionFromCurrentPage() {
        const page = await this.ensurePage();
        await page.goto(`${this.baseUrl}/my-account/plan`, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
        return page.evaluate(() => {
            const text = document.body.textContent ?? "";
            const numberAfter = (pattern, fallback) => Number.parseInt(text.match(pattern)?.[1] ?? String(fallback), 10) || fallback;
            return {
                planId: document.querySelector('[data-testid="plan-name"], [class*="PlanName"], h2')?.textContent?.trim() || "classic",
                mealsPerWeek: numberAfter(/(\d+)\s*(meals|maaltijden)/i, 0),
                servingsPerMeal: numberAfter(/(\d+)\s*(servings|personen)/i, 0),
                frequency: /biweekly|tweewekelijks/i.test(text) ? "biweekly" : "weekly",
                pricePerServing: Number.parseFloat(text.match(/[€$]\s*([\d.,]+)/)?.[1]?.replace(",", ".") ?? "0") || 0,
                nextDeliveryDate: document.querySelector('[data-testid*="next-delivery"], [class*="NextDelivery"]')?.textContent?.trim() || "",
                status: /paused|pauze/i.test(text) ? "Paused" : "Active",
            };
        });
    }
    async scrapePastOrdersFromCurrentPage(limit) {
        const page = await this.ensurePage();
        await page.goto(`${this.baseUrl}/my-account/orders`, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });
        return page.evaluate((maxOrders) => Array.from(document.querySelectorAll('[data-testid*="order"], [class*="OrderCard"], [class*="order-card"], article'))
            .slice(0, maxOrders)
            .map((el) => ({
            orderId: el.getAttribute("data-order-id") || el.getAttribute("data-id") || "",
            deliveryDate: el.querySelector('[class*="date"], [data-testid*="date"]')?.textContent?.trim() || "",
            meals: Array.from(el.querySelectorAll('[class*="meal"], [class*="recipe"]')).map((meal) => ({
                recipeId: meal.getAttribute("data-recipe-id") || "",
                recipeName: meal.textContent?.trim() || "",
                servings: 2,
            })),
            totalPrice: Number.parseFloat(el.textContent?.match(/[€$]\s*([\d.,]+)/)?.[1]?.replace(",", ".") ?? "0") || 0,
            status: el.querySelector('[class*="status"]')?.textContent?.trim() || "Delivered",
        })), limit);
    }
    async acceptCookiesIfPresent(page) {
        const selectors = [
            '[data-testid="cookie-consent-accept"]',
            'button:has-text("Accept All")',
            'button:has-text("Accept Cookies")',
            'button:has-text("Accepteren")',
            'button:has-text("Alles accepteren")',
        ];
        for (const selector of selectors) {
            const button = page.locator(selector).first();
            if (await button.isVisible({ timeout: 1_000 }).catch(() => false)) {
                await button.click().catch(() => { });
                return;
            }
        }
    }
    async clickSubmitFallback(page) {
        const submitBtn = page.locator('button[type="submit"], button:has-text("Log In"), button:has-text("Sign In"), button:has-text("Inloggen")').first();
        if (await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
            await submitBtn.click().catch(() => { });
        }
    }
    async extractLoginError(page) {
        const explicit = await page
            .locator('[data-testid*="error"], .error-message, [role="alert"]')
            .first()
            .textContent({ timeout: 2_000 })
            .catch(() => null);
        if (explicit?.trim())
            return explicit.trim();
        const body = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
        const line = body
            .split("\n")
            .map((part) => part.trim())
            .find((part) => /couldn.?t log in|invalid|incorrect|ongeldig|niet inloggen/i.test(part));
        return line || "Unknown error";
    }
    async setCheckboxByLocator(locator, value) {
        if (!(await locator.isVisible({ timeout: 3_000 }).catch(() => false))) {
            return { found: false, changed: false };
        }
        const isChecked = await locator.isChecked().catch(() => false);
        if (value !== isChecked) {
            await locator.click();
            return { found: true, changed: true };
        }
        return { found: true, changed: false };
    }
    async selectPlanOption(page, field, value) {
        const select = page.locator(`[data-testid*="${field}-select"], select[name*="${field}"]`).first();
        if (await select.isVisible({ timeout: 3_000 }).catch(() => false)) {
            await select.selectOption(String(value));
            return true;
        }
        const singular = field === "meals" ? "meal" : "serving";
        const button = page.locator(`button:has-text("${value} ${field}"), button:has-text("${value} ${singular}"), button:has-text("${value} maaltijden"), button:has-text("${value} personen"), [data-${field}="${value}"]`).first();
        if (await button.isVisible({ timeout: 3_000 }).catch(() => false)) {
            await button.click();
            return true;
        }
        return false;
    }
    static normalizeBaseUrl(url) {
        return url.replace(/\/+$/, "");
    }
    static baseUrlForCountry(country) {
        const code = country?.toUpperCase();
        if (code === "NL")
            return "https://www.hellofresh.nl";
        if (code === "DE")
            return "https://www.hellofresh.de";
        if (code === "BE")
            return "https://www.hellofresh.be";
        if (code === "FR")
            return "https://www.hellofresh.fr";
        if (code === "GB" || code === "UK")
            return "https://www.hellofresh.co.uk";
        if (code === "AU")
            return "https://www.hellofresh.com.au";
        if (code === "CA")
            return "https://www.hellofresh.ca";
        return "https://www.hellofresh.com";
    }
    static countryFromBaseUrl(baseUrl) {
        const host = new URL(baseUrl).hostname;
        if (host.endsWith(".nl"))
            return "NL";
        if (host.endsWith(".de"))
            return "DE";
        if (host.endsWith(".be"))
            return "BE";
        if (host.endsWith(".fr"))
            return "FR";
        if (host.endsWith(".co.uk"))
            return "GB";
        if (host.endsWith(".com.au"))
            return "AU";
        if (host.endsWith(".ca"))
            return "CA";
        return "US";
    }
    static localeForCountry(country) {
        switch (country.toUpperCase()) {
            case "NL":
                return "nl-NL";
            case "DE":
                return "de-DE";
            case "BE":
                return "nl-BE";
            case "FR":
                return "fr-FR";
            case "GB":
            case "UK":
                return "en-GB";
            case "AU":
                return "en-AU";
            case "CA":
                return "en-CA";
            default:
                return "en-US";
        }
    }
    static diffMeals(left, right) {
        const rightCounts = new Map();
        for (const meal of right) {
            rightCounts.set(meal.recipeId, (rightCounts.get(meal.recipeId) ?? 0) + meal.servings);
        }
        const result = [];
        for (const meal of left) {
            const remaining = rightCounts.get(meal.recipeId) ?? 0;
            if (remaining >= meal.servings) {
                rightCounts.set(meal.recipeId, remaining - meal.servings);
            }
            else {
                result.push({
                    ...meal,
                    servings: meal.servings - remaining,
                });
                rightCounts.set(meal.recipeId, 0);
            }
        }
        return result;
    }
    static parseAuthCookie(value) {
        const decoded = decodeURIComponent(value);
        const auth = JSON.parse(decoded);
        if (!auth.access_token || !auth.token_type || !auth.issued_at || !auth.expires_in) {
            throw new Error("HelloFresh API auth token is invalid.");
        }
        return auth;
    }
    static isAccessTokenExpired(auth) {
        return HelloFreshBrowser.authExpirySeconds(auth) <= Date.now() / 1000 + 60;
    }
    static isRefreshTokenExpired(auth) {
        if (!auth.refresh_token)
            return true;
        if (!auth.refresh_expires_in)
            return false;
        return auth.issued_at + auth.refresh_expires_in <= Date.now() / 1000 + 60;
    }
    static authExpirySeconds(auth) {
        return auth.issued_at + auth.expires_in;
    }
    static asArray(value) {
        return Array.isArray(value) ? value : [];
    }
    static recordValue(value) {
        return value && typeof value === "object" && !Array.isArray(value)
            ? value
            : undefined;
    }
    static stringValue(value) {
        if (value === null || value === undefined)
            return "";
        return String(value);
    }
    static maybeNumber(value) {
        if (typeof value === "number" && Number.isFinite(value))
            return value;
        if (typeof value === "string") {
            const parsed = Number.parseFloat(value.replace(",", "."));
            if (Number.isFinite(parsed))
                return parsed;
        }
        return undefined;
    }
    static uniqueStrings(values) {
        const seen = new Set();
        const out = [];
        for (const value of values) {
            const text = value?.trim();
            if (!text || seen.has(text))
                continue;
            seen.add(text);
            out.push(text);
        }
        return out;
    }
    static optionalString(value) {
        const text = HelloFreshBrowser.stringValue(value);
        return text || undefined;
    }
    static numberValue(value, fallback) {
        if (typeof value === "number" && Number.isFinite(value))
            return value;
        if (typeof value === "string") {
            const parsed = Number.parseFloat(value.replace(",", "."));
            if (Number.isFinite(parsed))
                return parsed;
        }
        return fallback;
    }
    static durationMinutes(value) {
        if (typeof value === "number" && Number.isFinite(value))
            return value;
        if (typeof value !== "string")
            return 0;
        const iso = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i);
        if (iso)
            return (Number(iso[1] ?? 0) * 60) + Number(iso[2] ?? 0);
        const plain = value.match(/(\d+)/);
        return plain ? Number(plain[1]) : 0;
    }
    static isoWeekOffset(offset) {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() + offset * 7);
        return HelloFreshBrowser.isoWeek(date);
    }
    static addIsoWeeks(week, offset) {
        if (offset === 0)
            return week;
        const match = week.match(/^(\d{4})-W(\d{2})$/);
        if (!match)
            return week;
        const year = Number(match[1]);
        const weekNumber = Number(match[2]);
        const jan4 = new Date(Date.UTC(year, 0, 4));
        const jan4Day = jan4.getUTCDay() || 7;
        const monday = new Date(jan4);
        monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (weekNumber - 1 + offset) * 7);
        return HelloFreshBrowser.isoWeek(monday);
    }
    static isoWeek(date) {
        const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
        const day = target.getUTCDay() || 7;
        target.setUTCDate(target.getUTCDate() + 4 - day);
        const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
        const week = Math.ceil((((target.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
        return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
    }
}
exports.HelloFreshBrowser = HelloFreshBrowser;
//# sourceMappingURL=browser.js.map