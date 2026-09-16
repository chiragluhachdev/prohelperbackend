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
import { HINDI_CATALOG } from './hindiCatalog.js';

const yesNo = (key, label, labelHi, extra = {}) => ({ key, label, labelHi, type: 'boolean', defaultValue: false, ...extra });
const notes = (label = 'Additional requirements', labelHi = 'अन्य ज़रूरतें', placeholder = 'Anything the helper should know', placeholderHi = 'हेल्पर को कुछ बताना हो तो लिखें') => ({
  key: 'additional_requirements', label, labelHi, type: 'textarea', placeholder, placeholderHi,
});
const choice = (key, label, labelHi, choices, choicesHi, { prices = [], minutes = [], required = true, defaultValue, help, helpHi } = {}) => ({
  key, label, labelHi, type: 'select', choices, choicesHi, choicePrices: prices, choiceMinutes: minutes,
  required, defaultValue: defaultValue ?? (required ? choices[0] : ''), help, helpHi,
});
const many = (key, label, labelHi, choices, choicesHi, { prices = [], minutes = [], required = true, help, helpHi } = {}) => ({
  key, label, labelHi, type: 'multiselect', choices, choicesHi, choicePrices: prices, choiceMinutes: minutes, required, defaultValue: [], help, helpHi,
});
const count = (key, label, labelHi, { min = 1, max = 10, defaultValue = 1, price = 0, perMinutes = 0, unit = '', unitHi = '', required = true } = {}) => ({
  key, label, labelHi, type: 'number', min, max, step: 1, defaultValue, pricePerUnit: price, minutesPerUnit: perMinutes, unit, unitHi, required,
});

const HOURS = { en: ['1 hour', '2 hours', '3 hours'], hi: ['1 घंटा', '2 घंटे', '3 घंटे'] };

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
      choice('home_size', 'Home size', 'घर का आकार', ['1 BHK', '2 BHK', '3 BHK', '4 BHK+'], ['1 BHK', '2 BHK', '3 BHK', '4 BHK+'], { defaultValue: '2 BHK' }),
      count('extra_bathrooms', 'Extra bathrooms', 'अतिरिक्त बाथरूम', { min: 0, max: 5, defaultValue: 0, price: 80, unit: 'bathrooms', unitHi: 'बाथरूम', required: false }),
      yesNo('balcony', 'Include balcony', 'बालकनी भी शामिल करें', { pricePerUnit: 60 }),
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
      choice('load', 'How much is there?', 'कितना काम है?', ['Light', 'Medium', 'Heavy'], ['हल्का', 'मध्यम', 'ज़्यादा'], { defaultValue: 'Medium' }),
      yesNo('chimney', 'Deep-clean the chimney', 'चिमनी की गहरी सफ़ाई', { pricePerUnit: 99 }),
    ],
  },
  {
    code: 'bathroom', name: 'Washroom Cleaning', nameHi: 'वॉशरूम की सफ़ाई', category: 'Cleaning', icon: '🚿',
    description: 'Commode, shower area, tiles, grout and fixtures disinfected.',
    basePrice: 149, durationLabel: '1 - 2 hours', defaultDurationMins: 60, sortOrder: 3,
    inclusions: [
      'Toilet and commode deep cleaning', 'Shower area and glass cleaning', 'Tile and grout scrubbing',
      'Mirror and fixture polishing', 'Floor cleaning and disinfecting',
    ],
    optionsEnabled: true,
    options: [
      choice('washrooms', 'Number of washrooms', 'कितने वॉशरूम', ['1', '2', '3', '4'], ['1', '2', '3', '4'], { prices: [0, 99, 199, 299], minutes: [0, 45, 90, 135] }),
      yesNo('deep_clean', 'Deep clean (hard water stains, grout)', 'गहरी सफ़ाई (पानी के दाग, ग्राउट)', { pricePerUnit: 99, minutesPerUnit: 30 }),
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
    code: 'dusting', name: 'Dusting', nameHi: 'धूल झाड़ना', category: 'Cleaning', icon: '🪶',
    description: 'Furniture, shelves, sills and surfaces dusted room by room.',
    descriptionHi: 'फ़र्नीचर, अलमारियाँ, खिड़कियाँ और सतहें — हर कमरे की धूल साफ़।',
    basePrice: 99, durationLabel: '30 - 60 minutes', durationLabelHi: '30 - 60 मिनट', defaultDurationMins: 30, sortOrder: 5,
    inclusions: ['Furniture and shelves', 'Window sills and doors', 'Switchboards and frames'],
    inclusionsHi: ['फ़र्नीचर और अलमारियाँ', 'खिड़की और दरवाज़े', 'स्विचबोर्ड और फ़्रेम'],
    optionsEnabled: true,
    options: [
      count('rooms', 'Number of rooms', 'कितने कमरे', { max: 8, defaultValue: 2, price: 25, perMinutes: 15, unit: 'rooms', unitHi: 'कमरे' }),
      yesNo('fans_high', 'Include fans and high shelves', 'पंखे और ऊँची अलमारियाँ भी', { pricePerUnit: 40, minutesPerUnit: 15 }),
    ],
  },
  {
    code: 'mopping', name: 'Mopping', nameHi: 'पोछा', category: 'Cleaning', icon: '🧽',
    description: 'Sweeping and wet mopping of every floor.',
    descriptionHi: 'हर फ़र्श पर झाड़ू और गीला पोछा।',
    basePrice: 99, durationLabel: '30 - 60 minutes', durationLabelHi: '30 - 60 मिनट', defaultDurationMins: 30, sortOrder: 6,
    inclusions: ['Sweeping all floors', 'Wet mopping with disinfectant', 'Under furniture where it moves'],
    inclusionsHi: ['सभी फ़र्शों पर झाड़ू', 'कीटाणुनाशक से गीला पोछा', 'हिलने वाले फ़र्नीचर के नीचे भी'],
    optionsEnabled: true,
    options: [
      choice('home_size', 'Home size', 'घर का आकार', ['1 BHK', '2 BHK', '3 BHK', '4 BHK+'], ['1 BHK', '2 BHK', '3 BHK', '4 BHK+'], { prices: [0, 40, 80, 120], minutes: [0, 15, 30, 45] }),
      yesNo('balcony', 'Include balcony', 'बालकनी भी शामिल करें', { pricePerUnit: 30, minutesPerUnit: 10 }),
    ],
  },
  {
    code: 'dishwashing', name: 'Dishwashing', nameHi: 'बर्तन धोना', category: 'Cleaning', icon: '🍽️',
    description: 'Utensils washed, dried and put away; sink left clean.',
    descriptionHi: 'बर्तन धोकर, सुखाकर रखे जाएँगे; सिंक साफ़ रहेगा।',
    basePrice: 99, durationLabel: '30 - 60 minutes', durationLabelHi: '30 - 60 मिनट', defaultDurationMins: 30, sortOrder: 7,
    inclusions: ['Washing all utensils', 'Drying and stacking', 'Sink and slab wipe-down'],
    inclusionsHi: ['सभी बर्तन धोना', 'सुखाना और रखना', 'सिंक और स्लैब पोंछना'],
    optionsEnabled: true,
    options: [
      choice('load', 'How many dishes?', 'कितने बर्तन हैं?', ['Light (one meal)', 'Medium (a day)', 'Heavy (a party)'], ['हल्का (एक समय का खाना)', 'मध्यम (पूरा दिन)', 'ज़्यादा (पार्टी)'], { prices: [0, 40, 100], minutes: [0, 20, 50] }),
      notes(),
    ],
  },
  {
    code: 'setting_utensils', name: 'Setting Utensils', nameHi: 'बर्तन जमाना', category: 'Cleaning', icon: '🥣',
    description: 'Utensils sorted, arranged and shelves wiped so the kitchen is easy to use.',
    descriptionHi: 'बर्तन छाँटकर जमाए जाएँगे और अलमारियाँ पोंछी जाएँगी।',
    basePrice: 99, durationLabel: '30 - 60 minutes', durationLabelHi: '30 - 60 मिनट', defaultDurationMins: 30, sortOrder: 8,
    inclusions: ['Sorting and arranging utensils', 'Wiping shelves and racks'],
    inclusionsHi: ['बर्तन छाँटना और जमाना', 'अलमारियाँ और रैक पोंछना'],
    optionsEnabled: true,
    options: [
      choice('scope', 'What should be set?', 'क्या जमाना है?', ['Kitchen shelves', 'Kitchen and dining', 'Full kitchen reorganise'], ['किचन की अलमारियाँ', 'किचन और डाइनिंग', 'पूरा किचन नए सिरे से'], { prices: [0, 50, 150], minutes: [0, 15, 45] }),
      notes(),
    ],
  },

  /* ------------------------------------------------------------- cooking */
  {
    code: 'cooking', name: 'Cooking', nameHi: 'खाना बनाना', category: 'Cooking', icon: '🍳',
    description: 'Home-style meals cooked in your kitchen, the way you like them.',
    descriptionHi: 'आपकी रसोई में, आपके स्वाद का घर जैसा खाना।',
    basePrice: 149, durationLabel: '1 - 2 hours', durationLabelHi: '1 - 2 घंटे', defaultDurationMins: 30, sortOrder: 9,
    inclusions: ['Chopping and preparation', 'Cooking the chosen meals', 'Cleaning the cooking area after'],
    inclusionsHi: ['कटाई और तैयारी', 'चुने हुए खाने बनाना', 'बाद में खाना बनाने की जगह साफ़ करना'],
    optionsEnabled: true,
    options: [
      count('people', 'Number of people', 'कितने लोगों के लिए', { max: 20, defaultValue: 2, price: 25, perMinutes: 5, unit: 'people', unitHi: 'लोग' }),
      many('meals', 'Which meals?', 'कौन-सा खाना?', ['Breakfast', 'Lunch', 'Dinner', 'Snacks'], ['नाश्ता', 'दोपहर का खाना', 'रात का खाना', 'स्नैक्स'], {
        prices: [50, 80, 80, 40], minutes: [30, 45, 45, 20], help: 'Pick every meal to be cooked in this visit.', helpHi: 'इस बार बनने वाले सभी खाने चुनें।',
      }),
      choice('diet', 'Food preference', 'खाने की पसंद', ['Vegetarian', 'Non-vegetarian', 'Jain'], ['शाकाहारी', 'मांसाहारी', 'जैन'], { prices: [0, 50, 0] }),
      { key: 'ready_by', label: 'Food ready by', labelHi: 'खाना कब तक तैयार हो', type: 'time', help: 'Leave empty if any time is fine.', helpHi: 'कोई भी समय ठीक हो तो खाली छोड़ें।' },
      notes('Additional requirements', 'अन्य ज़रूरतें', 'e.g. less oil, no onion-garlic', 'जैसे कम तेल, बिना प्याज़-लहसुन'),
    ],
  },
  {
    code: 'kitchen_assistance', name: 'Kitchen Assistance', nameHi: 'रसोई में मदद', category: 'Cooking', icon: '🧑‍🍳',
    description: 'An extra pair of hands while you cook — prep, serving and washing up.',
    descriptionHi: 'आपके खाना बनाते समय मदद — तैयारी, परोसना और बर्तन।',
    basePrice: 149, durationLabel: '1 - 3 hours', durationLabelHi: '1 - 3 घंटे', defaultDurationMins: 60, sortOrder: 10,
    inclusions: ['Chopping and prep', 'Cleaning as you cook', 'Serving and washing up'],
    inclusionsHi: ['कटाई और तैयारी', 'साथ-साथ सफ़ाई', 'परोसना और बर्तन धोना'],
    optionsEnabled: true,
    options: [
      many('tasks', 'What do you need help with?', 'किसमें मदद चाहिए?', ['Chopping and prep', 'Cleaning as you cook', 'Serving', 'Washing up after'], ['कटाई और तैयारी', 'साथ-साथ सफ़ाई', 'परोसना', 'बाद में बर्तन धोना'], { prices: [0, 0, 50, 50] }),
      choice('hours', 'How long?', 'कितनी देर?', HOURS.en, HOURS.hi, { prices: [0, 120, 240], minutes: [0, 60, 120] }),
      count('guests', 'Number of guests', 'कितने मेहमान', { min: 0, max: 50, defaultValue: 0, required: false, unit: 'guests', unitHi: 'मेहमान' }),
      notes(),
    ],
  },

  /* ------------------------------------------------------------- laundry */
  {
    code: 'clothes_washing', name: 'Clothes Washing', nameHi: 'कपड़े धोना', category: 'Laundry', icon: '👕',
    description: 'Clothes washed, rinsed and hung to dry — by hand or in your machine.',
    descriptionHi: 'कपड़े धोकर, खंगालकर सुखाने के लिए डाले जाएँगे — हाथ से या मशीन में।',
    basePrice: 149, durationLabel: '1 - 2 hours', durationLabelHi: '1 - 2 घंटे', defaultDurationMins: 45, sortOrder: 11,
    inclusions: ['Washing and rinsing', 'Hanging clothes to dry'],
    inclusionsHi: ['धोना और खंगालना', 'कपड़े सुखाने डालना'],
    optionsEnabled: true,
    options: [
      choice('load', 'How many clothes?', 'कितने कपड़े?', ['Small (1 bucket)', 'Medium (2 buckets)', 'Large (3+ buckets)'], ['कम (1 बाल्टी)', 'मध्यम (2 बाल्टी)', 'ज़्यादा (3+ बाल्टी)'], { prices: [0, 80, 160], minutes: [0, 30, 60] }),
      choice('method', 'How should they be washed?', 'कैसे धोने हैं?', ['Washing machine', 'By hand'], ['वॉशिंग मशीन', 'हाथ से'], { prices: [0, 60], minutes: [0, 30] }),
      yesNo('ironing', 'Iron the dry clothes', 'सूखे कपड़े प्रेस करें', { pricePerUnit: 100, minutesPerUnit: 45 }),
      notes(),
    ],
  },

  /* ---------------------------------------------------------------- care */
  {
    code: 'pet_care', name: 'Pet Care', nameHi: 'पालतू जानवरों की देखभाल', category: 'Care', icon: '🐾',
    description: 'Feeding, walks and company for your pets while you are busy or away.',
    descriptionHi: 'आपके व्यस्त या बाहर रहने पर पालतू जानवरों को खाना, सैर और साथ।',
    basePrice: 169, durationLabel: '1 - 4 hours', durationLabelHi: '1 - 4 घंटे', defaultDurationMins: 30, sortOrder: 12,
    inclusions: ['Feeding as you instruct', 'Walks and play', 'Water bowls refreshed'],
    inclusionsHi: ['आपके बताए अनुसार खाना', 'सैर और खेल', 'पानी का बर्तन बदलना'],
    optionsEnabled: true,
    options: [
      count('pets', 'Number of pets', 'कितने पालतू', { max: 5, defaultValue: 1, price: 80, unit: 'pets', unitHi: 'पालतू' }),
      many('pet_types', 'Type of pets', 'पालतू का प्रकार', ['Dog', 'Cat', 'Bird', 'Other'], ['कुत्ता', 'बिल्ली', 'पक्षी', 'अन्य']),
      many('care', 'What should the helper do?', 'हेल्पर क्या करे?', ['Feeding', 'Walking', 'Playing', 'Grooming'], ['खाना खिलाना', 'सैर कराना', 'खेलना', 'ग्रूमिंग'], {
        prices: [0, 60, 0, 150], minutes: [15, 30, 20, 45],
      }),
      choice('duration', 'Duration', 'कितनी देर', HOURS.en.concat('4 hours'), HOURS.hi.concat('4 घंटे'), { prices: [0, 120, 240, 360], minutes: [30, 90, 150, 210] }),
      notes('About your pets', 'पालतू के बारे में', 'Food, habits, temperament, vet number', 'खाना, आदतें, स्वभाव, डॉक्टर का नंबर'),
    ],
  },
  {
    code: 'child_care_day', name: 'Child Care – Day', nameHi: 'बच्चों की देखभाल – दिन', category: 'Care', icon: '👶',
    description: 'A trusted helper to look after your children during the day.',
    descriptionHi: 'दिन में आपके बच्चों की देखभाल के लिए भरोसेमंद हेल्पर।',
    basePrice: 349, durationLabel: '4 - 8 hours', durationLabelHi: '4 - 8 घंटे', defaultDurationMins: 240, sortOrder: 13,
    inclusions: ['Supervision and play', 'Feeding at set times', 'Keeping the play area tidy'],
    inclusionsHi: ['देखरेख और खेल', 'तय समय पर खाना खिलाना', 'खेलने की जगह साफ़ रखना'],
    optionsEnabled: true,
    options: [
      count('children', 'Number of children', 'कितने बच्चे', { max: 4, defaultValue: 1, price: 150, unit: 'children', unitHi: 'बच्चे' }),
      many('ages', "Children's ages", 'बच्चों की उम्र', ['Infant (under 1)', 'Toddler (1–3)', 'Child (4–10)'], ['शिशु (1 से कम)', 'छोटे (1–3)', 'बच्चे (4–10)']),
      choice('duration', 'Duration', 'कितनी देर', ['4 hours', '6 hours', '8 hours'], ['4 घंटे', '6 घंटे', '8 घंटे'], {
        prices: [0, 200, 400], minutes: [0, 120, 240],
        help: 'Care starts at the time you book for.', helpHi: 'देखभाल बुकिंग के समय से शुरू होगी।',
      }),
      { key: 'end_time', label: 'Care needed until', labelHi: 'देखभाल कब तक चाहिए', type: 'time', help: 'Optional — if you need a set end time.', helpHi: 'वैकल्पिक — अगर समाप्ति का समय तय है।' },
      yesNo('meals', 'Prepare simple meals for the children', 'बच्चों के लिए सादा खाना बनाएँ', { pricePerUnit: 100, minutesPerUnit: 30 }),
      notes('Additional requirements', 'अन्य ज़रूरतें', 'Allergies, nap and meal times, emergency contact', 'एलर्जी, सोने और खाने का समय, आपातकालीन नंबर'),
    ],
  },
  {
    code: 'malish', name: 'Malish', nameHi: 'मालिश', category: 'Care', icon: '💆',
    description: 'A relaxing traditional oil massage at home.',
    descriptionHi: 'घर पर आरामदायक पारंपरिक तेल मालिश।',
    basePrice: 299, durationLabel: '30 - 90 minutes', durationLabelHi: '30 - 90 मिनट', defaultDurationMins: 30, sortOrder: 14,
    inclusions: ['Full body or focused massage', 'Warm oil massage'],
    inclusionsHi: ['पूरे शरीर या किसी हिस्से की मालिश', 'गुनगुने तेल से मालिश'],
    optionsEnabled: true,
    options: [
      choice('for_whom', 'Massage for', 'मालिश किसके लिए', ['Adult', 'Elderly', 'Baby'], ['वयस्क', 'बुज़ुर्ग', 'शिशु']),
      choice('length', 'Length', 'कितनी देर', ['30 minutes', '60 minutes', '90 minutes'], ['30 मिनट', '60 मिनट', '90 मिनट'], { prices: [0, 200, 400], minutes: [0, 30, 60] }),
      choice('preference', 'Helper preference', 'हेल्पर की पसंद', ['No preference', 'Female helper', 'Male helper'], ['कोई भी', 'महिला हेल्पर', 'पुरुष हेल्पर']),
      yesNo('bring_oil', 'Helper brings massage oil', 'हेल्पर मालिश का तेल लाए', { pricePerUnit: 50 }),
      notes('Additional requirements', 'अन्य ज़रूरतें', 'Areas to focus on, any pain or conditions', 'किस हिस्से पर ध्यान दें, कोई दर्द या तकलीफ़'),
    ],
  },

  /* ----------------------------------------------------------------- car */
  {
    code: 'car_wash', name: 'Car Wash', nameHi: 'कार धुलाई', category: 'Car', icon: '🚙',
    description: 'Exterior wash and wipe at your parking spot.',
    descriptionHi: 'आपकी पार्किंग पर कार की बाहरी धुलाई और पोंछाई।',
    basePrice: 249, durationLabel: '45 - 60 minutes', durationLabelHi: '45 - 60 मिनट', defaultDurationMins: 45, sortOrder: 15,
    inclusions: ['Exterior foam wash', 'Windows and mirrors', 'Tyres and rims'],
    inclusionsHi: ['बाहर फ़ोम से धुलाई', 'शीशे और आईने', 'टायर और रिम'],
    optionsEnabled: true,
    options: [
      choice('car_type', 'Car type', 'कार का प्रकार', ['Hatchback', 'Sedan', 'SUV', 'MUV'], ['हैचबैक', 'सेडान', 'एसयूवी', 'एमयूवी'], { prices: [0, 50, 100, 120], minutes: [0, 10, 15, 20] }),
      yesNo('interior', 'Also clean the inside', 'अंदर की भी सफ़ाई', { pricePerUnit: 150, minutesPerUnit: 20 }),
      { key: 'parking_spot', label: 'Where is the car parked?', labelHi: 'कार कहाँ खड़ी है?', type: 'text', required: true, placeholder: 'e.g. Basement 2, slot B-114', placeholderHi: 'जैसे बेसमेंट 2, स्लॉट B-114' },
    ],
  },
  {
    code: 'car_deep_cleaning', name: 'Car Deep Cleaning', nameHi: 'कार की गहरी सफ़ाई', category: 'Car', icon: '🚗',
    description: 'Inside and out: vacuum, upholstery shampoo, dashboard and exterior wash.',
    descriptionHi: 'अंदर-बाहर: वैक्यूम, सीटों की शैम्पू सफ़ाई, डैशबोर्ड और बाहरी धुलाई।',
    basePrice: 599, durationLabel: '2 - 3 hours', durationLabelHi: '2 - 3 घंटे', defaultDurationMins: 120, sortOrder: 16,
    inclusions: ['Interior vacuum', 'Dashboard and panels', 'Exterior wash', 'Mats cleaned'],
    inclusionsHi: ['अंदर वैक्यूम', 'डैशबोर्ड और पैनल', 'बाहरी धुलाई', 'मैट की सफ़ाई'],
    optionsEnabled: true,
    options: [
      choice('car_type', 'Car type', 'कार का प्रकार', ['Hatchback', 'Sedan', 'SUV', 'MUV'], ['हैचबैक', 'सेडान', 'एसयूवी', 'एमयूवी'], { prices: [0, 150, 250, 300], minutes: [0, 20, 40, 45] }),
      yesNo('seat_shampoo', 'Seat shampoo', 'सीटों की शैम्पू सफ़ाई', { pricePerUnit: 300, minutesPerUnit: 45 }),
      yesNo('water_power', 'Water and a power point are near the car', 'कार के पास पानी और बिजली का पॉइंट है', {
        help: 'Needed for the vacuum and wash.', helpHi: 'वैक्यूम और धुलाई के लिए ज़रूरी।',
      }),
      { key: 'parking_spot', label: 'Where is the car parked?', labelHi: 'कार कहाँ खड़ी है?', type: 'text', required: true, placeholder: 'e.g. Basement 2, slot B-114', placeholderHi: 'जैसे बेसमेंट 2, स्लॉट B-114' },
    ],
  },

  /* -------------------------------------------------------------- garden */
  {
    code: 'gardening', name: 'Gardening', nameHi: 'बागवानी', category: 'Garden', icon: '🌱',
    description: 'Watering, weeding, trimming and planting for balconies and gardens.',
    descriptionHi: 'बालकनी और बगीचे के लिए पानी, निराई, छँटाई और पौधे लगाना।',
    basePrice: 199, durationLabel: '1 - 2 hours', durationLabelHi: '1 - 2 घंटे', defaultDurationMins: 45, sortOrder: 17,
    inclusions: ['Watering and weeding', 'Trimming and clean-up'],
    inclusionsHi: ['पानी देना और निराई', 'छँटाई और सफ़ाई'],
    optionsEnabled: true,
    options: [
      choice('size', 'Garden size', 'बगीचे का आकार', ['Balcony pots', 'Small garden', 'Large garden'], ['बालकनी के गमले', 'छोटा बगीचा', 'बड़ा बगीचा'], { prices: [0, 100, 250], minutes: [0, 30, 90] }),
      many('tasks', 'What needs doing?', 'क्या करना है?', ['Watering', 'Weeding', 'Trimming', 'Planting', 'Lawn mowing'], ['पानी देना', 'निराई', 'छँटाई', 'पौधे लगाना', 'घास काटना'], {
        prices: [0, 50, 80, 80, 150], minutes: [0, 20, 30, 30, 45],
      }),
      yesNo('bring_tools', 'Helper brings tools', 'हेल्पर औज़ार लाए', { pricePerUnit: 50 }),
      notes(),
    ],
  },

  /* --------------------------------------------------------------- other */
  {
    code: 'other_household', name: 'Other Household Services', nameHi: 'घर के अन्य काम', category: 'Other', icon: '🏡',
    description: 'Something else around the house? Tell us what you need.',
    descriptionHi: 'घर का कोई और काम? बताइए क्या चाहिए।',
    basePrice: 149, durationLabel: '1 - 3 hours', durationLabelHi: '1 - 3 घंटे', defaultDurationMins: 60, sortOrder: 18,
    inclusions: ['A helper for the task you describe'],
    inclusionsHi: ['आपके बताए काम के लिए हेल्पर'],
    optionsEnabled: true,
    options: [
      { key: 'task', label: 'What do you need help with?', labelHi: 'किस काम में मदद चाहिए?', type: 'textarea', required: true, placeholder: 'Describe the work', placeholderHi: 'काम के बारे में लिखें' },
      choice('hours', 'How long do you expect it to take?', 'इसमें कितना समय लगेगा?', HOURS.en, HOURS.hi, { prices: [0, 120, 240], minutes: [0, 60, 120] }),
    ],
  },
].map((service) => ({ ...(HINDI_CATALOG[service.code] || {}), ...service }));
