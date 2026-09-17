/**
 * The launch catalog (UC-C04 / UC-C05) — services, their questions, and what
 * each answer adds to the price and the time.
 *
 * This is starting data, not configuration: once in the database every word and
 * rupee here is the admin's to change. The seed writes it into a fresh database;
 * `npm run catalog:sync` adds anything missing to one that already exists
 * without touching what an admin has edited.
 *
 * Option pricing, for reference:
 *   number       pricePerUnit × value, minutesPerUnit × value
 *   boolean      pricePerUnit / minutesPerUnit when answered yes
 *   select       choicePrices[i] / choiceMinutes[i] for the chosen one
 *   multiselect  Σ choicePrices / choiceMinutes of every one picked
 */
const yesNo = (key, label, extra = {}) => ({ key, label, type: 'boolean', defaultValue: false, ...extra });
const notes = (label = 'Additional requirements', placeholder = 'Anything the helper should know') => ({
  key: 'additional_requirements', label, type: 'textarea', placeholder,
});
const choice = (key, label, choices, { prices = [], minutes = [], required = true, defaultValue, help } = {}) => ({
  key, label, type: 'select', choices, choicePrices: prices, choiceMinutes: minutes,
  required, defaultValue: defaultValue ?? (required ? choices[0] : ''), help,
});
const many = (key, label, choices, { prices = [], minutes = [], required = true, help } = {}) => ({
  key, label, type: 'multiselect', choices, choicePrices: prices, choiceMinutes: minutes, required, defaultValue: [], help,
});
const count = (key, label, { min = 1, max = 10, defaultValue = 1, price = 0, perMinutes = 0, unit = '', required = true } = {}) => ({
  key, label, type: 'number', min, max, step: 1, defaultValue, pricePerUnit: price, minutesPerUnit: perMinutes, unit, required,
});

const HOURS = ['1 hour', '2 hours', '3 hours'];

export const CATALOG = [
  /* ------------------------------------------------------------ cleaning */
  {
    code: 'full_home', name: 'Full Home Cleaning', category: 'Cleaning', icon: '🏠',
    description: 'Dusting, floors, bathrooms and kitchen — the whole house in one visit.',
    basePrice: 249, durationLabel: '2 - 4 hours', defaultDurationMins: 180, sortOrder: 1,
    inclusions: [
      'Dusting all rooms and surfaces', 'Sweeping and mopping all floors', 'Bathroom deep cleaning',
      'Kitchen cleaning and organising', 'Trash removal and disposal',
    ],
    optionsEnabled: false,
    options: [
      choice('home_size', 'Home size', ['1 BHK', '2 BHK', '3 BHK', '4 BHK+'], { defaultValue: '2 BHK' }),
      count('extra_bathrooms', 'Extra bathrooms', { min: 0, max: 5, defaultValue: 0, price: 80, unit: 'bathrooms', required: false }),
      yesNo('balcony', 'Include balcony', { pricePerUnit: 60 }),
    ],
  },
  {
    code: 'kitchen', name: 'Kitchen Cleaning', category: 'Cleaning', icon: '🍲',
    description: 'Slabs, stove, chimney, sink and cabinet fronts scrubbed down.',
    basePrice: 149, durationLabel: '1 - 2 hours', defaultDurationMins: 90, sortOrder: 2,
    inclusions: [
      'Cleaning kitchen slabs and countertops', 'Stove, hob and chimney cleaning', 'Sink cleaning and descaling',
      'Outside cleaning of cabinets and drawers', 'Floor cleaning and trash removal',
    ],
    optionsEnabled: false,
    options: [
      choice('load', 'How much is there?', ['Light', 'Medium', 'Heavy'], { defaultValue: 'Medium' }),
      yesNo('chimney', 'Deep-clean the chimney', { pricePerUnit: 99 }),
    ],
  },
  {
    code: 'bathroom', name: 'Washroom Cleaning', category: 'Cleaning', icon: '🚿',
    description: 'Commode, shower area, tiles, grout and fixtures disinfected.',
    basePrice: 149, durationLabel: '1 - 2 hours', defaultDurationMins: 60, sortOrder: 3,
    inclusions: [
      'Toilet and commode deep cleaning', 'Shower area and glass cleaning', 'Tile and grout scrubbing',
      'Mirror and fixture polishing', 'Floor cleaning and disinfecting',
    ],
    optionsEnabled: true,
    options: [
      choice('washrooms', 'Number of washrooms', ['1', '2', '3', '4'], { prices: [0, 99, 199, 299], minutes: [0, 45, 90, 135] }),
      yesNo('deep_clean', 'Deep clean (hard water stains, grout)', { pricePerUnit: 99, minutesPerUnit: 30 }),
    ],
  },
  {
    code: 'sofa', name: 'Sofa & Upholstery Cleaning', category: 'Cleaning', icon: '🛋️',
    description: 'Vacuum, shampoo and stain treatment for sofas and upholstery.',
    basePrice: 199, durationLabel: '1 - 2 hours', defaultDurationMins: 90, sortOrder: 4,
    inclusions: [
      'Vacuuming sofa and cushions', 'Stain removal treatment', 'Deep fabric cleaning',
      'Deodorising and sanitising', 'Drying and fluffing cushions',
    ],
    optionsEnabled: false,
    options: [],
  },
  {
    code: 'dusting', name: 'Dusting', category: 'Cleaning', icon: '🪶',
    description: 'Furniture, shelves, sills and surfaces dusted room by room.',
    basePrice: 99, durationLabel: '30 - 60 minutes', defaultDurationMins: 30, sortOrder: 5,
    inclusions: ['Furniture and shelves', 'Window sills and doors', 'Switchboards and frames'],
    optionsEnabled: true,
    options: [
      count('rooms', 'Number of rooms', { max: 8, defaultValue: 2, price: 25, perMinutes: 15, unit: 'rooms' }),
      yesNo('fans_high', 'Include fans and high shelves', { pricePerUnit: 40, minutesPerUnit: 15 }),
    ],
  },
  {
    code: 'mopping', name: 'Mopping', category: 'Cleaning', icon: '🧽',
    description: 'Sweeping and wet mopping of every floor.',
    basePrice: 99, durationLabel: '30 - 60 minutes', defaultDurationMins: 30, sortOrder: 6,
    inclusions: ['Sweeping all floors', 'Wet mopping with disinfectant', 'Under furniture where it moves'],
    optionsEnabled: true,
    options: [
      choice('home_size', 'Home size', ['1 BHK', '2 BHK', '3 BHK', '4 BHK+'], { prices: [0, 40, 80, 120], minutes: [0, 15, 30, 45] }),
      yesNo('balcony', 'Include balcony', { pricePerUnit: 30, minutesPerUnit: 10 }),
    ],
  },
  {
    code: 'dishwashing', name: 'Dishwashing', category: 'Cleaning', icon: '🍽️',
    description: 'Utensils washed, dried and put away; sink left clean.',
    basePrice: 99, durationLabel: '30 - 60 minutes', defaultDurationMins: 30, sortOrder: 7,
    inclusions: ['Washing all utensils', 'Drying and stacking', 'Sink and slab wipe-down'],
    optionsEnabled: true,
    options: [
      choice('load', 'How many dishes?', ['Light (one meal)', 'Medium (a day)', 'Heavy (a party)'], { prices: [0, 40, 100], minutes: [0, 20, 50] }),
      notes(),
    ],
  },
  {
    code: 'setting_utensils', name: 'Setting Utensils', category: 'Cleaning', icon: '🥣',
    description: 'Utensils sorted, arranged and shelves wiped so the kitchen is easy to use.',
    basePrice: 99, durationLabel: '30 - 60 minutes', defaultDurationMins: 30, sortOrder: 8,
    inclusions: ['Sorting and arranging utensils', 'Wiping shelves and racks'],
    optionsEnabled: true,
    options: [
      choice('scope', 'What should be set?', ['Kitchen shelves', 'Kitchen and dining', 'Full kitchen reorganise'], { prices: [0, 50, 150], minutes: [0, 15, 45] }),
      notes(),
    ],
  },

  /* ------------------------------------------------------------- cooking */
  {
    code: 'cooking', name: 'Cooking', category: 'Cooking', icon: '🍳',
    description: 'Home-style meals cooked in your kitchen, the way you like them.',
    basePrice: 149, durationLabel: '1 - 2 hours', defaultDurationMins: 30, sortOrder: 9,
    inclusions: ['Chopping and preparation', 'Cooking the chosen meals', 'Cleaning the cooking area after'],
    optionsEnabled: true,
    options: [
      count('people', 'Number of people', { max: 20, defaultValue: 2, price: 25, perMinutes: 5, unit: 'people' }),
      many('meals', 'Which meals?', ['Breakfast', 'Lunch', 'Dinner', 'Snacks'], {
        prices: [50, 80, 80, 40], minutes: [30, 45, 45, 20], help: 'Pick every meal to be cooked in this visit.',
      }),
      choice('diet', 'Food preference', ['Vegetarian', 'Non-vegetarian', 'Jain'], { prices: [0, 50, 0] }),
      { key: 'ready_by', label: 'Food ready by', type: 'time', help: 'Leave empty if any time is fine.' },
      notes('Additional requirements', 'e.g. less oil, no onion-garlic'),
    ],
  },
  {
    code: 'kitchen_assistance', name: 'Kitchen Assistance', category: 'Cooking', icon: '🧑‍🍳',
    description: 'An extra pair of hands while you cook — prep, serving and washing up.',
    basePrice: 149, durationLabel: '1 - 3 hours', defaultDurationMins: 60, sortOrder: 10,
    inclusions: ['Chopping and prep', 'Cleaning as you cook', 'Serving and washing up'],
    optionsEnabled: true,
    options: [
      many('tasks', 'What do you need help with?', ['Chopping and prep', 'Cleaning as you cook', 'Serving', 'Washing up after'], { prices: [0, 0, 50, 50] }),
      choice('hours', 'How long?', HOURS, { prices: [0, 120, 240], minutes: [0, 60, 120] }),
      count('guests', 'Number of guests', { min: 0, max: 50, defaultValue: 0, required: false, unit: 'guests' }),
      notes(),
    ],
  },

  /* ------------------------------------------------------------- laundry */
  {
    code: 'clothes_washing', name: 'Clothes Washing', category: 'Laundry', icon: '👕',
    description: 'Clothes washed, rinsed and hung to dry — by hand or in your machine.',
    basePrice: 149, durationLabel: '1 - 2 hours', defaultDurationMins: 45, sortOrder: 11,
    inclusions: ['Washing and rinsing', 'Hanging clothes to dry'],
    optionsEnabled: true,
    options: [
      choice('load', 'How many clothes?', ['Small (1 bucket)', 'Medium (2 buckets)', 'Large (3+ buckets)'], { prices: [0, 80, 160], minutes: [0, 30, 60] }),
      choice('method', 'How should they be washed?', ['Washing machine', 'By hand'], { prices: [0, 60], minutes: [0, 30] }),
      yesNo('ironing', 'Iron the dry clothes', { pricePerUnit: 100, minutesPerUnit: 45 }),
      notes(),
    ],
  },

  /* ---------------------------------------------------------------- care */
  {
    code: 'pet_care', name: 'Pet Care', category: 'Care', icon: '🐾',
    description: 'Feeding, walks and company for your pets while you are busy or away.',
    basePrice: 169, durationLabel: '1 - 4 hours', defaultDurationMins: 30, sortOrder: 12,
    inclusions: ['Feeding as you instruct', 'Walks and play', 'Water bowls refreshed'],
    optionsEnabled: true,
    options: [
      count('pets', 'Number of pets', { max: 5, defaultValue: 1, price: 80, unit: 'pets' }),
      many('pet_types', 'Type of pets', ['Dog', 'Cat', 'Bird', 'Other']),
      many('care', 'What should the helper do?', ['Feeding', 'Walking', 'Playing', 'Grooming'], {
        prices: [0, 60, 0, 150], minutes: [15, 30, 20, 45],
      }),
      choice('duration', 'Duration', HOURS.concat('4 hours'), { prices: [0, 120, 240, 360], minutes: [30, 90, 150, 210] }),
      notes('About your pets', 'Food, habits, temperament, vet number'),
    ],
  },
  {
    code: 'child_care_day', name: 'Child Care – Day', category: 'Care', icon: '👶',
    description: 'A trusted helper to look after your children during the day.',
    basePrice: 349, durationLabel: '4 - 8 hours', defaultDurationMins: 240, sortOrder: 13,
    inclusions: ['Supervision and play', 'Feeding at set times', 'Keeping the play area tidy'],
    optionsEnabled: true,
    options: [
      count('children', 'Number of children', { max: 4, defaultValue: 1, price: 150, unit: 'children' }),
      many('ages', "Children's ages", ['Infant (under 1)', 'Toddler (1–3)', 'Child (4–10)']),
      choice('duration', 'Duration', ['4 hours', '6 hours', '8 hours'], {
        prices: [0, 200, 400], minutes: [0, 120, 240],
        help: 'Care starts at the time you book for.',
      }),
      { key: 'end_time', label: 'Care needed until', type: 'time', help: 'Optional — if you need a set end time.' },
      yesNo('meals', 'Prepare simple meals for the children', { pricePerUnit: 100, minutesPerUnit: 30 }),
      notes('Additional requirements', 'Allergies, nap and meal times, emergency contact'),
    ],
  },
  {
    code: 'malish', name: 'Malish', category: 'Care', icon: '💆',
    description: 'A relaxing traditional oil massage at home.',
    basePrice: 299, durationLabel: '30 - 90 minutes', defaultDurationMins: 30, sortOrder: 14,
    inclusions: ['Full body or focused massage', 'Warm oil massage'],
    optionsEnabled: true,
    options: [
      choice('for_whom', 'Massage for', ['Adult', 'Elderly', 'Baby']),
      choice('length', 'Length', ['30 minutes', '60 minutes', '90 minutes'], { prices: [0, 200, 400], minutes: [0, 30, 60] }),
      choice('preference', 'Helper preference', ['No preference', 'Female helper', 'Male helper']),
      yesNo('bring_oil', 'Helper brings massage oil', { pricePerUnit: 50 }),
      notes('Additional requirements', 'Areas to focus on, any pain or conditions'),
    ],
  },

  /* ----------------------------------------------------------------- car */
  {
    code: 'car_wash', name: 'Car Wash', category: 'Car', icon: '🚙',
    description: 'Exterior wash and wipe at your parking spot.',
    basePrice: 249, durationLabel: '45 - 60 minutes', defaultDurationMins: 45, sortOrder: 15,
    inclusions: ['Exterior foam wash', 'Windows and mirrors', 'Tyres and rims'],
    optionsEnabled: true,
    options: [
      choice('car_type', 'Car type', ['Hatchback', 'Sedan', 'SUV', 'MUV'], { prices: [0, 50, 100, 120], minutes: [0, 10, 15, 20] }),
      yesNo('interior', 'Also clean the inside', { pricePerUnit: 150, minutesPerUnit: 20 }),
      { key: 'parking_spot', label: 'Where is the car parked?', type: 'text', required: true, placeholder: 'e.g. Basement 2, slot B-114' },
    ],
  },
  {
    code: 'car_deep_cleaning', name: 'Car Deep Cleaning', category: 'Car', icon: '🚗',
    description: 'Inside and out: vacuum, upholstery shampoo, dashboard and exterior wash.',
    basePrice: 599, durationLabel: '2 - 3 hours', defaultDurationMins: 120, sortOrder: 16,
    inclusions: ['Interior vacuum', 'Dashboard and panels', 'Exterior wash', 'Mats cleaned'],
    optionsEnabled: true,
    options: [
      choice('car_type', 'Car type', ['Hatchback', 'Sedan', 'SUV', 'MUV'], { prices: [0, 150, 250, 300], minutes: [0, 20, 40, 45] }),
      yesNo('seat_shampoo', 'Seat shampoo', { pricePerUnit: 300, minutesPerUnit: 45 }),
      yesNo('water_power', 'Water and a power point are near the car', {
        help: 'Needed for the vacuum and wash.',
      }),
      { key: 'parking_spot', label: 'Where is the car parked?', type: 'text', required: true, placeholder: 'e.g. Basement 2, slot B-114' },
    ],
  },

  /* -------------------------------------------------------------- garden */
  {
    code: 'gardening', name: 'Gardening', category: 'Garden', icon: '🌱',
    description: 'Watering, weeding, trimming and planting for balconies and gardens.',
    basePrice: 199, durationLabel: '1 - 2 hours', defaultDurationMins: 45, sortOrder: 17,
    inclusions: ['Watering and weeding', 'Trimming and clean-up'],
    optionsEnabled: true,
    options: [
      choice('size', 'Garden size', ['Balcony pots', 'Small garden', 'Large garden'], { prices: [0, 100, 250], minutes: [0, 30, 90] }),
      many('tasks', 'What needs doing?', ['Watering', 'Weeding', 'Trimming', 'Planting', 'Lawn mowing'], {
        prices: [0, 50, 80, 80, 150], minutes: [0, 20, 30, 30, 45],
      }),
      yesNo('bring_tools', 'Helper brings tools', { pricePerUnit: 50 }),
      notes(),
    ],
  },

  /* --------------------------------------------------------------- other */
  {
    code: 'other_household', name: 'Other Household Services', category: 'Other', icon: '🏡',
    description: 'Something else around the house? Tell us what you need.',
    basePrice: 149, durationLabel: '1 - 3 hours', defaultDurationMins: 60, sortOrder: 18,
    inclusions: ['A helper for the task you describe'],
    optionsEnabled: true,
    options: [
      { key: 'task', label: 'What do you need help with?', type: 'textarea', required: true, placeholder: 'Describe the work' },
      choice('hours', 'How long do you expect it to take?', HOURS, { prices: [0, 120, 240], minutes: [0, 60, 120] }),
    ],
  },
];
