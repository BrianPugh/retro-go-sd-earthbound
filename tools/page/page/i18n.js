// Page translations and the locale store.
//
// Dependency-free by necessity: this page ships as static files to GitHub
// Pages and the whole point of the project is that what runs is settled at
// build time, so pulling an i18n library from a CDN at load time would be
// working against it. The shape deliberately mirrors gnw-web-builder's own
// i18n so the two read the same way: strings nested by section rather than
// flat dotted keys, English as the base that every other locale is checked
// against, values that need arguments written as functions returning template
// literals, and the language remembered in localStorage under "locale".
//
// Two different languages meet on this page and must not be confused. This
// module handles the *page* language -- the words in the interface. Which
// language the converted game data ends up in is decided by which ROM the user
// supplies, and is described by the manifest. Someone may well want a German
// interface while building a French asset pack.
//
// House style for the copy below, learned from review:
//   - "convert", not "extract". Users are converting a file they own into one
//     the port can read; "extraction" is our word, not theirs.
//   - no em dashes anywhere. Break the sentence or use a comma.
//   - translations are written the way someone would actually speak. German in
//     particular should not chain every proper noun into one compound.

export const SUPPORTED = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
];

// English is the base. Every other locale below is a translation of exactly
// these keys; a missing key falls back to the English one rather than showing
// a blank or a key name to the user.
const en = {
  app: {
    heading: (title) => `${title} asset converter`,
    lede: (game, output) => `Convert your ${game} ROM into ${output}`,
  },
  lang: {
    label: "Language",
    aria: "Choose the language of this page",
  },
  io: {
    input: "Input",
    output: "Output",
  },
  why: {
    label: "What this does",
    text: "Runs in your browser. Your ROM never leaves your computer.",
  },
  input: {
    heading: "ROM files",
    choose: "Choose file",
    none: "No file chosen",
    optional: "optional",
    // The control on a role the manifest marks repeatable. Deliberately
    // says nothing about what the extra files are: the role's own
    // description, which the manifest owns, is right above it.
    addFile: "+ Add another file",
    remove: "Remove",
    alreadyAdded: (name) => `${name} has already been added.`,
    variantAlreadyAdded: (variant) => `${variant} is already added.`,
    wrongRole: (name, other, role) =>
      `${name} is the file for "${other}", not for "${role}".`,
    // Refusals. Each one names the file, says what was wanted, and gives the
    // hash the file actually has, so someone with a folder of ROMs can work
    // out which one they are holding.
    notTheOne: (name, variant, expected, actual) =>
      `Needs ${variant}. SHA-1 ${expected}, yours ${actual}.`,
    notRecognised: (name, role, actual) =>
      `Not a supported release. SHA-1 ${actual}. See "?" for the list.`,
    help: "What this is",
    accepted: "Available:",
    showHashes: "Accepted hashes",
    reading: (name) => `Reading ${name}…`,
    tooLarge: (name) => `${name} is too big to be the right file.`,
    recognised: (name, variant) => variant,
    unrecognised: (name, role) =>
      `${name} is not a stock ${role}. Treating it as a modified copy.`,
    missingRequired: "Choose the required file to continue.",
  },
  run: {
    heading: "Convert",
    button: "Convert",
    starting: "Starting…",
    progress: (pct, name, stage, stages) =>
      `${pct}% · ${name} (step ${stage} of ${stages})`,
    timedOut: "This took too long and was stopped.",
    done: (n) => `Done, ${n} file${n === 1 ? "" : "s"} ready.`,
    tooBig: (name, size, max) =>
      `${name} came out at ${size} bytes, more than the ${max} its manifest allows.`,
  },
  version: {
    label: "Version",
    // A prerelease is opt-in: it is offered only once someone asks to see one.
    showPrereleases: "Show pre-releases",
    prerelease: "pre-release",
    // The firmware requirement, shown per version because this is the only
    // place a user learns it. A binary built for a newer ABI hardfaults on
    // device with nothing on screen to explain why.
    abi: (version, minSize) => `firmware ABI ${version}+ (${minSize} bytes)`,
    retained: (n) => `Showing the ${n} most recent releases.`,
    olderReleases: "Older releases",
    pinned: (tag) => `Version ${tag}`,
    noConverter: "This version needs no conversion: install the published files as they are.",
  },
  zip: {
    button: "Download everything",
    note: (names) => `One zip: ${names}`,
    building: "Fetching the published files and packing them…",
    ready: (name, bytes) => `${name} saved, ${bytes.toLocaleString("en-GB")} bytes.`,
    failed: (msg) => `Could not build the zip: ${msg}`,
    fetchFailed: (name, status) => `could not fetch ${name} (${status})`,
    sizeMismatch: (name, got, want) =>
      `${name} is ${got} bytes, but its manifest says ${want}`,
    hashMismatch: (name) => `${name} does not match the hash in its manifest`,
  },
  results: {
    heading: "Output",
    download: (name) => `Download ${name}`,
    bytes: (n) => `${n.toLocaleString("en-GB")} bytes`,
    hash: "Hash",
    hashMatches: "Hash matches ✓",
    hashDiffers: "Hash does not match ✗",
  },
  footer: {
    source: "Source and documentation:",
    repo: "the project repository",
    published: "",
  },
  fatal: {
    cannotRun: (msg) => `This page cannot run: ${msg}`,
    noManifest: "the converter manifest could not be loaded",
    noVersions: "this site publishes no versions",
    mismatch: "the converter does not match its manifest",
    unsafe: (errs) => `the converter failed its safety checks: ${errs}`,
  },
};

const fr = {
  app: {
    heading: (title) => `Convertisseur de ressources ${title}`,
    lede: (game, output) => `Convertissez votre ROM ${game} en ${output}`,
  },
  lang: {
    label: "Langue",
    aria: "Choisir la langue de cette page",
  },
  io: {
    input: "Entrée",
    output: "Sortie",
  },
  why: {
    label: "Ce que fait cette page",
    text: "Tout se passe dans votre navigateur. Votre ROM ne quitte pas votre ordinateur.",
  },
  input: {
    heading: "Fichiers ROM",
    choose: "Choisir un fichier",
    none: "Aucun fichier choisi",
    optional: "facultatif",
    addFile: "+ Ajouter un fichier",
    remove: "Retirer",
    alreadyAdded: (name) => `${name} a déjà été ajouté.`,
    variantAlreadyAdded: (variant) => `${variant} est déjà ajouté.`,
    wrongRole: (name, other, role) =>
      `${name} correspond à « ${other} », pas à « ${role} ».`,
    notTheOne: (name, variant, expected, actual) =>
      `Il faut ${variant}. SHA-1 ${expected}, le vôtre ${actual}.`,
    notRecognised: (name, role, actual) =>
      `Version non prise en charge. SHA-1 ${actual}. Voir « ? » pour la liste.`,
    help: "Ce que c'est",
    accepted: "Disponibles :",
    showHashes: "Empreintes acceptées",
    reading: (name) => `Lecture de ${name}…`,
    tooLarge: (name) => `${name} est trop volumineux pour être le bon fichier.`,
    recognised: (name, variant) => variant,
    unrecognised: (name, role) =>
      `${name} n'est pas un ${role} d'origine. Il sera traité comme une copie modifiée.`,
    missingRequired: "Choisissez le fichier requis pour continuer.",
  },
  run: {
    heading: "Convertir",
    button: "Convertir",
    starting: "Démarrage…",
    progress: (pct, name, stage, stages) =>
      `${pct} % · ${name} (étape ${stage} sur ${stages})`,
    timedOut: "L'opération a pris trop de temps et a été interrompue.",
    done: (n) => `Terminé, ${n} fichier${n === 1 ? "" : "s"} prêt${n === 1 ? "" : "s"}.`,
    tooBig: (name, size, max) =>
      `${name} fait ${size} octets, plus que les ${max} autorisés par son manifeste.`,
  },
  version: {
    label: "Version",
    showPrereleases: "Afficher les préversions",
    prerelease: "préversion",
    abi: (version, minSize) => `ABI firmware ${version}+ (${minSize} octets)`,
    retained: (n) => `Les ${n} versions les plus récentes.`,
    olderReleases: "Versions plus anciennes",
    pinned: (tag) => `Version ${tag}`,
    noConverter: "Cette version ne demande aucune conversion : installez les fichiers publiés tels quels.",
  },
  zip: {
    button: "Tout télécharger",
    note: (names) => `Une archive : ${names}`,
    building: "Récupération des fichiers publiés et création de l'archive…",
    ready: (name, bytes) => `${name} enregistré, ${bytes.toLocaleString("fr-FR")} octets.`,
    failed: (msg) => `Impossible de créer l'archive : ${msg}`,
    fetchFailed: (name, status) => `${name} n'a pas pu être récupéré (${status})`,
    sizeMismatch: (name, got, want) =>
      `${name} fait ${got} octets alors que son manifeste en annonce ${want}`,
    hashMismatch: (name) => `${name} ne correspond pas à l'empreinte de son manifeste`,
  },
  results: {
    heading: "Sortie",
    download: (name) => `Télécharger ${name}`,
    bytes: (n) => `${n.toLocaleString("fr-FR")} octets`,
    hash: "Empreinte",
    hashMatches: "Empreinte conforme ✓",
    hashDiffers: "Empreinte non conforme ✗",
  },
  footer: {
    source: "Code source et documentation :",
    repo: "le dépôt du projet",
    published: "",
  },
  fatal: {
    cannotRun: (msg) => `Cette page ne peut pas fonctionner : ${msg}`,
    noManifest: "le manifeste du convertisseur n'a pas pu être chargé",
    noVersions: "ce site ne publie aucune version",
    mismatch: "le convertisseur ne correspond pas à son manifeste",
    unsafe: (errs) => `le convertisseur a échoué aux contrôles de sécurité : ${errs}`,
  },
};

const de = {
  app: {
    heading: (title) => `${title} Asset-Konverter`,
    lede: (game, output) => `Wandle dein ${game} ROM in ${output} um`,
  },
  lang: {
    label: "Sprache",
    aria: "Sprache dieser Seite wählen",
  },
  io: {
    input: "Eingabe",
    output: "Ausgabe",
  },
  why: {
    label: "Was hier passiert",
    text: "Läuft im Browser. Dein ROM bleibt auf deinem Rechner.",
  },
  input: {
    heading: "ROM-Dateien",
    choose: "Datei auswählen",
    none: "Keine Datei ausgewählt",
    optional: "optional",
    addFile: "+ Weitere Datei hinzufügen",
    remove: "Entfernen",
    alreadyAdded: (name) => `${name} wurde schon hinzugefügt.`,
    variantAlreadyAdded: (variant) => `${variant} ist schon dabei.`,
    wrongRole: (name, other, role) =>
      `${name} gehört zu „${other}“ und nicht zu „${role}“.`,
    notTheOne: (name, variant, expected, actual) =>
      `Gebraucht wird ${variant}. SHA-1 ${expected}, deins ${actual}.`,
    notRecognised: (name, role, actual) =>
      `Keine unterstützte Version. SHA-1 ${actual}. Liste im „?“.`,
    help: "Was das ist",
    accepted: "Verfügbar:",
    showHashes: "Akzeptierte Prüfsummen",
    reading: (name) => `${name} wird gelesen…`,
    tooLarge: (name) => `${name} ist zu groß für die erwartete Datei.`,
    recognised: (name, variant) => variant,
    unrecognised: (name, role) =>
      `${name} ist kein unverändertes ${role}. Es wird als bearbeitete Fassung behandelt.`,
    missingRequired: "Wähle die benötigte Datei aus, um weiterzumachen.",
  },
  run: {
    heading: "Umwandeln",
    button: "Umwandeln",
    starting: "Es geht los…",
    progress: (pct, name, stage, stages) =>
      `${pct} % · ${name} (Schritt ${stage} von ${stages})`,
    timedOut: "Das hat zu lange gedauert und wurde abgebrochen.",
    done: (n) => `Fertig, ${n} Datei${n === 1 ? "" : "en"} bereit.`,
    tooBig: (name, size, max) =>
      `${name} ist ${size} Bytes groß, mehr als die im Manifest erlaubten ${max}.`,
  },
  version: {
    label: "Version",
    showPrereleases: "Vorabversionen anzeigen",
    prerelease: "Vorabversion",
    abi: (version, minSize) => `Firmware-ABI ${version}+ (${minSize} Bytes)`,
    retained: (n) => `Die ${n} neuesten Versionen.`,
    olderReleases: "Ältere Versionen",
    pinned: (tag) => `Version ${tag}`,
    noConverter: "Diese Version braucht keine Umwandlung: installiere die veröffentlichten Dateien so, wie sie sind.",
  },
  zip: {
    button: "Alles herunterladen",
    note: (names) => `Ein Archiv: ${names}`,
    building: "Die veröffentlichten Dateien werden geholt und gepackt…",
    ready: (name, bytes) => `${name} gespeichert, ${bytes.toLocaleString("de-DE")} Bytes.`,
    failed: (msg) => `Das Archiv konnte nicht erstellt werden: ${msg}`,
    fetchFailed: (name, status) => `${name} konnte nicht geladen werden (${status})`,
    sizeMismatch: (name, got, want) =>
      `${name} hat ${got} Bytes, das Manifest nennt aber ${want}`,
    hashMismatch: (name) => `${name} passt nicht zur Prüfsumme im Manifest`,
  },
  results: {
    heading: "Ausgabe",
    download: (name) => `${name} herunterladen`,
    bytes: (n) => `${n.toLocaleString("de-DE")} Bytes`,
    hash: "Prüfsumme",
    hashMatches: "Prüfsumme stimmt ✓",
    hashDiffers: "Prüfsumme stimmt nicht ✗",
  },
  footer: {
    source: "Quellcode und Dokumentation:",
    repo: "das Projekt-Repository",
    published: "",
  },
  fatal: {
    cannotRun: (msg) => `Diese Seite funktioniert nicht: ${msg}`,
    noManifest: "das Manifest des Konverters konnte nicht geladen werden",
    noVersions: "diese Seite veröffentlicht keine Versionen",
    mismatch: "der Konverter passt nicht zu seinem Manifest",
    unsafe: (errs) => `der Konverter hat die Sicherheitsprüfungen nicht bestanden: ${errs}`,
  },
};

const STRINGS = { en, fr, de };

// Fall back key by key rather than whole-locale, so a partial translation
// degrades to English only where it is actually missing.
function withFallback(locale) {
  const base = STRINGS.en;
  const over = STRINGS[locale] ?? {};
  const out = {};
  for (const section of Object.keys(base)) {
    out[section] = { ...base[section], ...(over[section] ?? {}) };
  }
  return out;
}

// A visitor whose browser is set to a language we speak should get it without
// touching anything. Region is ignored: de-AT and de-DE both get German.
function matchBrowser() {
  for (const tag of navigator.languages ?? [navigator.language ?? "en"]) {
    const want = tag.toLowerCase().split("-")[0];
    if (SUPPORTED.some((l) => l.code === want)) return want;
  }
  return "en";
}

function initial() {
  let stored = null;
  try {
    stored = localStorage.getItem("locale");
  } catch { /* storage blocked: fall back to the browser's language */ }
  // An explicit choice outranks the browser's setting, but only once made.
  return SUPPORTED.some((l) => l.code === stored) ? stored : matchBrowser();
}

let current = initial();
let strings = withFallback(current);
const listeners = new Set();

export const locale = () => current;
export const t = () => strings;

export function setLocale(code) {
  if (!SUPPORTED.some((l) => l.code === code)) return;
  current = code;
  strings = withFallback(code);
  try {
    localStorage.setItem("locale", code);
  } catch { /* not persisting is survivable; the page still switches */ }
  document.documentElement.lang = code;
  for (const fn of listeners) fn();
}

/** Runs `fn` now and again on every language change. */
export function onLocaleChange(fn) {
  listeners.add(fn);
  fn();
}

/**
 * Reads a localised string out of the manifest, which stores them as
 * `{en, fr, de}` objects. Plain strings are passed through so a manifest that
 * has not been localised still renders.
 */
export function localeText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return value[current] ?? value.en ?? "";
}

/**
 * Applies translations to any element carrying `data-i18n="section.key"`, plus
 * `data-i18n-title` and `data-i18n-aria-label` for the attribute forms. Keeps
 * the static markup readable and means adding a string to the page is one
 * attribute rather than a line of JS.
 */
export function applyStatic(root = document) {
  const lookup = (path) => {
    const [section, key] = path.split(".");
    const v = strings[section]?.[key];
    return typeof v === "function" ? v() : v;
  };
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const v = lookup(el.dataset.i18n);
    if (v != null) el.textContent = v;
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    const v = lookup(el.dataset.i18nTitle);
    if (v != null) el.title = v;
  }
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) {
    const v = lookup(el.dataset.i18nAriaLabel);
    if (v != null) el.setAttribute("aria-label", v);
  }
}
