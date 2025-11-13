import * as builder from "~/builder.ts"

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
  package: {
    speller: {
      name: string
      version: string
    }
    grammar: {
      name: string
      version: string
    }
    "tts-text-proc": {
      name: string
      version: string
    }
  }
  windows: WindowsSpellerManifest
  macos: {
    system_pkg_id: string
  }
}

export function deriveLangTag() {
  console.log("repoName", builder.env.repoName)
  const lang = builder.env.repoName.split("lang-")[1]?.split("-")[0]
  console.log("lang", lang)

  // Map ISO 639-3 codes to ISO 639-1 codes where they exist
  // This is the complete set of ISO 639-1 languages that might be relevant
  const iso639_3_to_639_1: { [key: string]: string } = {
    aar: "aa",
    abk: "ab",
    afr: "af",
    aka: "ak",
    amh: "am",
    ara: "ar",
    arg: "an",
    asm: "as",
    ava: "av",
    ave: "ae",
    aym: "ay",
    aze: "az",
    bak: "ba",
    bam: "bm",
    bel: "be",
    ben: "bn",
    bis: "bi",
    bod: "bo",
    bos: "bs",
    bre: "br",
    bul: "bg",
    cat: "ca",
    ces: "cs",
    cha: "ch",
    che: "ce",
    chu: "cu",
    chv: "cv",
    cor: "kw",
    cos: "co",
    cre: "cr",
    cym: "cy",
    dan: "da",
    deu: "de",
    div: "dv",
    dzo: "dz",
    ell: "el",
    eng: "en",
    epo: "eo",
    est: "et",
    eus: "eu",
    ewe: "ee",
    fao: "fo",
    fas: "fa",
    fij: "fj",
    fin: "fi",
    fra: "fr",
    fry: "fy",
    ful: "ff",
    gla: "gd",
    gle: "ga",
    glg: "gl",
    glv: "gv",
    grn: "gn",
    guj: "gu",
    hat: "ht",
    hau: "ha",
    hbs: "sh",
    heb: "he",
    her: "hz",
    hin: "hi",
    hmo: "ho",
    hrv: "hr",
    hun: "hu",
    hye: "hy",
    ibo: "ig",
    ido: "io",
    iii: "ii",
    iku: "iu",
    ile: "ie",
    ina: "ia",
    ind: "id",
    ipk: "ik",
    isl: "is",
    ita: "it",
    jav: "jv",
    jpn: "ja",
    kal: "kl",
    kan: "kn",
    kas: "ks",
    kat: "ka",
    kau: "kr",
    kaz: "kk",
    khm: "km",
    kik: "ki",
    kin: "rw",
    kir: "ky",
    kom: "kv",
    kon: "kg",
    kor: "ko",
    kua: "kj",
    kur: "ku",
    lao: "lo",
    lat: "la",
    lav: "lv",
    lim: "li",
    lin: "ln",
    lit: "lt",
    ltz: "lb",
    lub: "lu",
    lug: "lg",
    mah: "mh",
    mal: "ml",
    mar: "mr",
    mkd: "mk",
    mlg: "mg",
    mlt: "mt",
    mon: "mn",
    mri: "mi",
    msa: "ms",
    mya: "my",
    nau: "na",
    nav: "nv",
    nbl: "nr",
    nde: "nd",
    ndo: "ng",
    nep: "ne",
    nld: "nl",
    nno: "nn",
    nob: "nb",
    nor: "no",
    nya: "ny",
    oci: "oc",
    oji: "oj",
    ori: "or",
    orm: "om",
    oss: "os",
    pan: "pa",
    pli: "pi",
    pol: "pl",
    por: "pt",
    pus: "ps",
    que: "qu",
    roh: "rm",
    ron: "ro",
    run: "rn",
    rus: "ru",
    sag: "sg",
    san: "sa",
    sin: "si",
    slk: "sk",
    slv: "sl",
    sme: "se",
    smo: "sm",
    sna: "sn",
    snd: "sd",
    som: "so",
    sot: "st",
    spa: "es",
    sqi: "sq",
    srd: "sc",
    srp: "sr",
    ssw: "ss",
    sun: "su",
    swa: "sw",
    swe: "sv",
    tah: "ty",
    tam: "ta",
    tat: "tt",
    tel: "te",
    tgk: "tg",
    tgl: "tl",
    tha: "th",
    tir: "ti",
    ton: "to",
    tsn: "tn",
    tso: "ts",
    tuk: "tk",
    tur: "tr",
    twi: "tw",
    uig: "ug",
    ukr: "uk",
    urd: "ur",
    uzb: "uz",
    ven: "ve",
    vie: "vi",
    vol: "vo",
    wln: "wa",
    wol: "wo",
    xho: "xh",
    yid: "yi",
    yor: "yo",
    zha: "za",
    zho: "zh",
    zul: "zu",
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
