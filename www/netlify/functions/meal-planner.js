// netlify/functions/meal-planner.js
// Generates a 7-day meal plan using the Edamam Meal Planning API
// Respects dietary preferences, health labels, and calorie targets

const EDAMAM_APP_ID = process.env.EDAMAM_APP_ID || '1ef4c0b1';
const EDAMAM_APP_KEY = process.env.EDAMAM_APP_KEY || 'daec12ed3f068a898d0a991a779b7004';
const EDAMAM_BASE = 'https://api.edamam.com';

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600' // Cache meal plans for 1 hour
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const {
      calories = 2000,
      diet = '',           // vegetarian, vegan, pescatarian, paleo, keto
      health = [],         // gluten-free, dairy-free, etc.
      cuisineType = [],    // british, italian, etc.
      servings = 2,
      days = 7
    } = body;

    // Build query parameters for Edamam
    // IMPORTANT: 'field' must use multiple append() calls, NOT comma-separated values
    const params = new URLSearchParams({
      app_id: EDAMAM_APP_ID,
      app_key: EDAMAM_APP_KEY,
      type: 'public',
    });
    // Each field must be a separate parameter
    ['label','image','url','yield','calories','totalTime','cuisineType','mealType','ingredientLines','totalNutrients']
      .forEach(f => params.append('field', f));

    // Add calorie range per meal (breakfast ~25%, lunch ~35%, dinner ~40%)
    const mealCalories = {
      breakfast: Math.round(calories * 0.25),
      lunch: Math.round(calories * 0.35),
      dinner: Math.round(calories * 0.40)
    };

    // Default search queries per meal type
    const mealQueries = {
      breakfast: 'eggs',
      lunch: 'chicken salad',
      dinner: 'chicken'
    };

    // Fetch recipes for each meal type
    const mealTypes = ['breakfast', 'lunch', 'dinner'];
    const recipePromises = mealTypes.map(async mealType => {
      const mealParams = new URLSearchParams(params);
      mealParams.set('mealType', mealType);
      // Add a search query - required by Edamam v2
      mealParams.set('q', mealQueries[mealType]);

      // Note: calorie filter removed as it's too restrictive with mealType
      // Calories are still shown per serving in the results

      // Diet filter
      if (diet && diet !== '') {
        mealParams.set('diet', diet);
      }

      // Health labels
      health.forEach(h => mealParams.append('health', h));

      // Cuisine type
      if (cuisineType.length > 0) {
        cuisineType.slice(0, 3).forEach(c => mealParams.append('cuisineType', c));
      }

      // Request enough recipes to fill 7 days
      mealParams.set('from', '0');
      mealParams.set('to', '20');

      const url = `${EDAMAM_BASE}/api/recipes/v2?${mealParams.toString()}`;
      let res;
      try {
        res = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'Edamam-Account-User': 'aquipax-app'
          },
          signal: AbortSignal.timeout(12000)
        });
      } catch (fetchErr) {
        console.error(`Fetch failed for ${mealType}:`, fetchErr.message);
        return { mealType, recipes: [] };
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`Edamam error for ${mealType}: ${res.status} - ${errText.slice(0,200)}`);
        return { mealType, recipes: [] };
      }

      const data = await res.json();
      console.log(`Edamam ${mealType}: ${(data.hits||[]).length} recipes`);
      // Minimum calories per person per meal type
      const minCalsPerPerson = { breakfast: 200, lunch: 250, dinner: 350 };
      const minCals = minCalsPerPerson[mealType] || 200;

      const recipes = (data.hits || []).map(hit => {
        const r = hit.recipe;
        const perServing = Math.round((r.calories || 0) / (r.yield || 2));
        return {
          label: r.label,
          image: r.image,
          url: r.url,
          yield: r.yield || 2,
          calories: perServing, // per serving
          totalCalories: Math.round(r.calories || 0),
          totalTime: r.totalTime || 0,
          cuisineType: r.cuisineType?.[0] || '',
          mealType: mealType,
          ingredientLines: r.ingredientLines || [],
          nutrients: {
            protein: Math.round((r.totalNutrients?.PROCNT?.quantity || 0) / (r.yield || 2)),
            carbs: Math.round((r.totalNutrients?.CHOCDF?.quantity || 0) / (r.yield || 2)),
            fat: Math.round((r.totalNutrients?.FAT?.quantity || 0) / (r.yield || 2)),
            fibre: Math.round((r.totalNutrients?.FIBTG?.quantity || 0) / (r.yield || 2))
          }
        };
      }).filter(r => r.calories >= minCals); // Only include recipes with sensible portion sizes

      return { mealType, recipes };
    });

    const results = await Promise.all(recipePromises);

    // Build 7-day meal plan
    const plan = {};
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    const recipesByType = {};
    results.forEach(r => {
      recipesByType[r.mealType] = r.recipes;
    });

    // Shuffle and assign recipes to days
    for (let d = 0; d < days; d++) {
      const day = dayNames[d];
      plan[day] = {};

      mealTypes.forEach(mealType => {
        const recipes = recipesByType[mealType] || [];
        if (recipes.length > 0) {
          // Pick recipe for this day (cycle through available recipes)
          const recipe = recipes[d % recipes.length];
          // Scale ingredients to servings
          const scaleFactor = servings / (recipe.yield || 2);
          plan[day][mealType] = {
            ...recipe,
            servings,
            scaledCalories: Math.round(recipe.calories * servings),
            scaledIngredients: recipe.ingredientLines.map(line => {
              // Simple scaling: multiply numbers in the ingredient line
              return line.replace(/(\d+(?:\.\d+)?)/g, (match) => {
                const scaled = parseFloat(match) * scaleFactor;
                return scaled % 1 === 0 ? scaled.toString() : scaled.toFixed(1);
              });
            })
          };
        }
      });
    }

    // Build consolidated shopping list
    const shoppingList = {};
    Object.values(plan).forEach(dayMeals => {
      Object.values(dayMeals).forEach(meal => {
        if (!meal) return;
        (meal.scaledIngredients || meal.ingredientLines || []).forEach(line => {
          // Extract ingredient name (simplified - remove quantities)
          const ingredientName = line
            .replace(/^\d+[\d/\s]*(?:cup|tbsp|tsp|oz|lb|g|kg|ml|l|clove|bunch|slice|piece|large|medium|small|whole|fresh|dried|chopped|minced|diced|sliced|grated|shredded|cooked|raw|frozen|canned|tin|can|pack|bag|bottle)s?\s*/gi, '')
            .replace(/[,;].*$/, '')
            .trim()
            .toLowerCase();

          if (ingredientName.length > 2) {
            if (!shoppingList[ingredientName]) {
              shoppingList[ingredientName] = { lines: [], count: 0 };
            }
            shoppingList[ingredientName].lines.push(line);
            shoppingList[ingredientName].count++;
          }
        });
      });
    });

    // Calculate daily calorie totals
    const dailyTotals = {};
    Object.entries(plan).forEach(([day, meals]) => {
      dailyTotals[day] = Object.values(meals).reduce((sum, meal) => {
        return sum + (meal?.scaledCalories || 0);
      }, 0);
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        plan,
        shoppingList: Object.entries(shoppingList)
          .sort((a, b) => b[1].count - a[1].count)
          .map(([name, data]) => ({
            name,
            count: data.count,
            example: data.lines[0]
          })),
        dailyTotals,
        targetCalories: calories,
        servings,
        days,
        generatedAt: new Date().toISOString()
      })
    };

  } catch (err) {
    console.error('Meal planner error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to generate meal plan. Please try again.' })
    };
  }
};
