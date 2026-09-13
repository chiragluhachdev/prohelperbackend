/**
 * Hindi copy for the launch catalog.
 *
 * Shared by the seed (fresh databases) and the backfill script (databases that
 * already exist). Kept apart from the seed on purpose: re-running the seed on
 * a live database resets every price and name the admin has changed.
 */
export const HINDI_CATALOG = {
  full_home: {
    nameHi: 'पूरे घर की सफ़ाई',
    descriptionHi: 'धूल, फ़र्श, बाथरूम और किचन — पूरा घर एक ही बार में।',
    durationLabelHi: '2 - 4 घंटे',
    inclusionsHi: [
      'सभी कमरों और सतहों की धूल साफ़',
      'सभी फ़र्शों पर झाड़ू और पोछा',
      'बाथरूम की गहरी सफ़ाई',
      'किचन की सफ़ाई और व्यवस्था',
      'कचरा हटाना और फेंकना',
    ],
  },
  kitchen: {
    nameHi: 'किचन की सफ़ाई',
    descriptionHi: 'स्लैब, चूल्हा, चिमनी, सिंक और कैबिनेट के सामने की सफ़ाई।',
    durationLabelHi: '1 - 2 घंटे',
    inclusionsHi: [
      'किचन स्लैब और काउंटरटॉप की सफ़ाई',
      'चूल्हा, हॉब और चिमनी की सफ़ाई',
      'सिंक की सफ़ाई और जमी गंदगी हटाना',
      'कैबिनेट और दराज़ों की बाहर से सफ़ाई',
      'फ़र्श की सफ़ाई और कचरा हटाना',
    ],
  },
  bathroom: {
    nameHi: 'बाथरूम की सफ़ाई',
    descriptionHi: 'कमोड, शॉवर, टाइल्स, ग्राउट और फ़िटिंग्स को कीटाणुरहित करना।',
    durationLabelHi: '1 - 2 घंटे',
    inclusionsHi: [
      'टॉयलेट और कमोड की गहरी सफ़ाई',
      'शॉवर एरिया और काँच की सफ़ाई',
      'टाइल्स और ग्राउट की रगड़कर सफ़ाई',
      'शीशे और फ़िटिंग्स की चमक',
      'फ़र्श की सफ़ाई और कीटाणुरहित करना',
    ],
  },
  sofa: {
    nameHi: 'सोफ़ा और अपहोल्स्ट्री की सफ़ाई',
    descriptionHi: 'सोफ़े और अपहोल्स्ट्री की वैक्यूम, शैम्पू और दाग़ हटाने की सफ़ाई।',
    durationLabelHi: '1 - 2 घंटे',
    inclusionsHi: [
      'सोफ़ा और कुशन की वैक्यूम सफ़ाई',
      'दाग़ हटाने का ट्रीटमेंट',
      'कपड़े की गहरी सफ़ाई',
      'बदबू हटाना और कीटाणुरहित करना',
      'सुखाना और कुशन को फुलाना',
    ],
  },
};
