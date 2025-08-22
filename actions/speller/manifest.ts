import * as builder from "~/builder.ts";

export enum SpellerType {
  MacOS = "speller-macos",
  Mobile = "speller-mobile",
  Windows = "speller-windows",
}

export type WindowsSpellerManifest = {
  system_product_code: string

  // This includes a list of UUIDs that need to be uninstalled before installing the new one.
  legacy_product_codes?: { value: string; kind: string }[]

  // Extra locales to register, prefix of zhfst is the value
  extra_locales?: { [bcp47: string]: string }
}

export type SpellerManifest = {
  spellername: string
  spellerversion: string
  windows: WindowsSpellerManifest
  macos: {
    system_pkg_id: string
  }
}

export function deriveLangTag() {
  console.log("repoName", builder.env.repoName)
  const lang = builder.env.repoName.split("lang-")[1]
  console.log("lang", lang)

  // Map ISO 639-3 codes to ISO 639-1 codes where they exist
  // This is the complete set of ISO 639-1 languages that might be relevant
  const iso639_3_to_639_1: { [key: string]: string } = {
    // Germanic languages
    "afr": "af", // Afrikaans
    "deu": "de", // German
    "eng": "en", // English
    "nld": "nl", // Dutch
    "dan": "da", // Danish
    "isl": "is", // Icelandic
    "nor": "no", // Norwegian
    "nno": "nn", // Norwegian Nynorsk
    "nob": "nb", // Norwegian Bokmål
    "swe": "sv", // Swedish
    "fao": "fo", // Faroese

    // Sami languages
    "sme": "se", // Northern Sami

    // Finno-Ugric languages
    "fin": "fi", // Finnish
    "est": "et", // Estonian
    "hun": "hu", // Hungarian

    // Celtic languages
    "gle": "ga", // Irish
    "gla": "gd", // Scottish Gaelic
    "cym": "cy", // Welsh
    "bre": "br", // Breton
    "cor": "kw", // Cornish
    "glv": "gv", // Manx

    // Romance languages
    "spa": "es", // Spanish
    "fra": "fr", // French
    "ita": "it", // Italian
    "por": "pt", // Portuguese
    "ron": "ro", // Romanian
    "cat": "ca", // Catalan

    // Slavic languages
    "rus": "ru", // Russian
    "pol": "pl", // Polish
    "ces": "cs", // Czech
    "slk": "sk", // Slovak
    "ukr": "uk", // Ukrainian
    "bel": "be", // Belarusian
    "bul": "bg", // Bulgarian
    "hrv": "hr", // Croatian
    "srp": "sr", // Serbian
    "slv": "sl", // Slovenian
    "bos": "bs", // Bosnian
    "mkd": "mk", // Macedonian

    // Baltic languages
    "lit": "lt", // Lithuanian
    "lav": "lv", // Latvian

    // Other European languages
    "ell": "el", // Greek
    "alb": "sq", // Albanian
    "eus": "eu", // Basque
    "mlt": "mt", // Maltese

    // Greenlandic
    "kal": "kl", // Kalaallisut (Greenlandic)

    // Asian languages
    "zho": "zh", // Chinese
    "jpn": "ja", // Japanese
    "kor": "ko", // Korean
    "tha": "th", // Thai
    "vie": "vi", // Vietnamese
    "hin": "hi", // Hindi
    "urd": "ur", // Urdu
    "ben": "bn", // Bengali
    "tam": "ta", // Tamil
    "tel": "te", // Telugu
    "mar": "mr", // Marathi
    "guj": "gu", // Gujarati
    "kan": "kn", // Kannada
    "mal": "ml", // Malayalam
    "ori": "or", // Odia
    "pan": "pa", // Punjabi
    "asm": "as", // Assamese
    "nep": "ne", // Nepali
    "sin": "si", // Sinhala
    "mya": "my", // Myanmar
    "khm": "km", // Khmer
    "lao": "lo", // Lao
    "mon": "mn", // Mongolian
    "tib": "bo", // Tibetan

    // Middle Eastern languages
    "ara": "ar", // Arabic
    "heb": "he", // Hebrew
    "fas": "fa", // Persian
    "tur": "tr", // Turkish
    "aze": "az", // Azerbaijani
    "kaz": "kk", // Kazakh
    "kir": "ky", // Kyrgyz
    "uzb": "uz", // Uzbek
    "tgk": "tg", // Tajik
    "tuk": "tk", // Turkmen
    "tat": "tt", // Tatar
    "bak": "ba", // Bashkir
    "chv": "cv", // Chuvash
    "sah": "sa", // Yakut

    // African languages
    "swa": "sw", // Swahili
    "hau": "ha", // Hausa
    "yor": "yo", // Yoruba
    "ibo": "ig", // Igbo
    "amh": "am", // Amharic
    "som": "so", // Somali
    "orm": "om", // Oromo
    "tir": "ti", // Tigrinya
    "kin": "rw", // Kinyarwanda
    "run": "rn", // Kirundi
    "mlg": "mg", // Malagasy
    "sna": "sn", // Shona
    "nde": "nd", // North Ndebele
    "nbl": "nr", // South Ndebele
    "sot": "st", // Southern Sotho
    "tsn": "tn", // Tswana
    "ven": "ve", // Venda
    "xho": "xh", // Xhosa
    "zul": "zu", // Zulu

    // American languages
    "que": "qu", // Quechua
    "grn": "gn", // Guarani
    "aym": "ay", // Aymara

    // Pacific languages
    "mao": "mi", // Māori
    "fij": "fj", // Fijian
    "ton": "to", // Tongan
    "haw": "hh", // Hawaiian (non-standard, but sometimes used)

    // Constructed languages
    "epo": "eo", // Esperanto

    // Additional languages that might be relevant
    "ido": "io", // Ido
    "ina": "ia", // Interlingua
    "vol": "vo", // Volapük
  }

  // Check if we have a mapping for this 3-letter code
  if (iso639_3_to_639_1[lang]) {
    return iso639_3_to_639_1[lang]
  }

  // If no mapping found, return the original code
  return lang
}

export function derivePackageId(_type: SpellerType) {
  const lang = builder.env.repo.split("lang-")[1].replace(/\.git$/, "")

  return `speller-${lang}`
}
