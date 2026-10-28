// The page's own logic. This is a reference consumer of the GWRG distribution
// spec: it reads the same versions.json and manifest.json a third-party
// installer reads, resolved the same way, and it uses the same verify.mjs and
// extract.mjs. If the spec or the ABI drifts, this page breaks in CI before
// anything else does.
//
// It is also deliberately project-agnostic. Every project-specific word on this
// page comes from the manifest; nothing here knows what game it is converting.
// The file is byte-identical across the projects that use it, so a change made
// for one is a change made for all.
//
// Every string that came from the module or the manifest is inserted with
// textContent, never innerHTML. Both are data we fetched, not code we trust.

import { verify } from "./verify.mjs";
import { makeZip } from "./zip.mjs";
import { SUPPORTED, applyStatic, localeText, onLocaleChange, setLocale, locale, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);

// Where the index lives, relative to this page. build-page.sh writes the real
// value into config.json; this is the fallback for a site laid out the usual
// way. The page hardcodes no filenames beyond these two entry points, because
// a consuming tool cannot hardcode any.
const DEFAULT_VERSIONS = "dist/versions.json";
// An offline bundle is a manifest and its files in one directory, with no
// index above them. Falling back to a manifest beside the page is what lets
// this same page open one.
const DEFAULT_MANIFEST = "manifest.json";
const RUN_TIMEOUT_MS = 120_000;

// `files` holds the accepted entries for each input role, keyed by role id.
// The value is always an array of { bytes, sha1, name, variant }: a role the
// manifest marks repeatable can hold several files, any other role holds at
// most one. A role the user has not filled is absent.
const state = {
  wasmBytes: null, tool: null, manifest: null, files: new Map(), lastResults: null,
  // The index, the entry currently loaded, and the URL it was read from --
  // every manifest url is resolved against that, per the spec's resolution
  // rules, so the page never builds a path of its own.
  index: null, version: null, versionsUrl: null, manifestUrl: null,
  showPrereleases: false,
  // The hashes of a verified reference run. Not a manifest field: the manifest
  // describes what to install, and no two users need get the same bytes out of
  // a converter. This is the project's own record of one run it stands behind,
  // published beside this page and used only to tell a user whether the
  // extraction they just did matches it.
  reference: null,
};

const setStatus = (el, cls, text) => {
  el.hidden = false;
  el.className = `status ${cls}`;
  el.textContent = text;
};

const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function digest(algo, bytes) {
  return hex(await crypto.subtle.digest(algo, bytes));
}

// The spec renamed inputs[].repeatable to allowMultiple. Older published
// manifests still say repeatable, and the version picker can load any of them,
// so accept either and carry one name inwards. Without this a manifest using
// the new spelling reads as "one file only" and a role that takes several --
// zelda3's translations -- silently accepts one.
function normaliseTool(tool) {
  if (!tool) return tool;
  const inputs = (tool.inputs ?? []).map((i) =>
    i.allowMultiple === undefined ? i : { ...i, repeatable: i.allowMultiple });
  return { ...tool, inputs };
}

const roles = () => state.tool?.inputs ?? [];
const requiredRoles = () => roles().filter((r) => r.required);
const filesFor = (roleId) => state.files.get(roleId) ?? [];
// Manifest order, flattened. The module identifies each file by content, so
// this order is a convenience for the reader, not a contract.
const allFiles = () => roles().flatMap((r) => filesFor(r.id));

/**
 * Whether this input insists on a file it recognises. `strict` defaults to
 * true: an input that says nothing wants a known hash. A project whose users
 * routinely supply modified ROMs clears it, because a hack cannot match a
 * known hash by construction.
 */
const isStrict = (role) => role.strict !== false;

// --- load and verify the module -------------------------------------------
//
// This happens silently. Verification is not a feature the user asked for and
// they cannot act on its details; it either passes, in which case saying so is
// noise, or it fails, in which case the page cannot work and must say why.

// Revalidate rather than trusting the cache. A manifest names its module and
// that module's hash, so a stale manifest fetches a stale module -- and because
// the pair is internally consistent the hash check passes, leaving the
// staleness to surface later as a confusing verification failure. This has
// happened; do not remove the cache option.
const FRESH = { cache: "no-cache" };

/**
 * Fetches a manifest and the module it describes, and checks both. Returns the
 * loaded pair, or throws with the reason this source is unusable.
 */
async function loadFrom(manifestUrl) {
  const manRes = await fetch(manifestUrl, FRESH).catch(() => null);
  if (!manRes || !manRes.ok) throw new Error(t().fatal.noManifest);
  const manifest = await manRes.json();

  if (manifest.schemaVersion !== 1) {
    throw new Error(
      `manifest declares schemaVersion ${manifest.schemaVersion}, this page reads 1`,
    );
  }
  // A version may legitimately declare no converter -- `tools: []` is the
  // spec's way of saying "nothing to convert, just install what is published".
  // That is not an error, it is a different page state.
  const tool = manifest.tools?.[0];
  if (!tool) return { manifest, tool: null, bytes: null, sha256: null };

  if (tool.processor?.type !== "wasm" || tool.processor?.version !== 1) {
    throw new Error(
      `manifest declares processor ${tool.processor?.type}/${tool.processor?.version}, ` +
      `this page implements wasm/1`,
    );
  }

  // Every url in a manifest is a plain filename resolved beside the manifest
  // that named it, which is what lets the same manifest work from this site
  // and from an offline bundle.
  const binary = tool.binary;
  const moduleUrl = new URL(binary.url ?? binary.file, new URL(manifestUrl, location.href));
  // Content-address the request so a new module can never be served from a
  // cache entry belonging to an older one. The hash is checked below either
  // way; this stops the wrong bytes arriving in the first place.
  if (binary.sha256) moduleUrl.searchParams.set("v", binary.sha256.slice(0, 16));
  const wasmRes = await fetch(moduleUrl, FRESH);
  if (!wasmRes.ok) throw new Error(`could not fetch ${binary.file} (${wasmRes.status})`);
  const bytes = new Uint8Array(await wasmRes.arrayBuffer());

  if (binary.bytes && bytes.length !== binary.bytes) {
    throw new Error(`${binary.file}: expected ${binary.bytes} bytes, got ${bytes.length}`);
  }

  // The manifest says which bytes it describes. If they disagree, the manifest
  // is describing something other than what we are about to run, and the honest
  // response is to refuse rather than to prefer one of them.
  const sha256 = await digest("SHA-256", bytes);
  if (sha256 !== binary.sha256) throw new Error(t().fatal.mismatch);

  // The real gate: decided by reading the binary, not by reading the manifest.
  const result = verify(bytes);
  if (!result.ok) throw new Error(t().fatal.unsafe(result.errors.join("; ")));

  return { manifest, tool, bytes, sha256 };
}

/** Reads config.json, which build-page.sh writes. Absent is not an error. */
async function readConfig() {
  try {
    const cfg = await fetch("config.json", FRESH);
    if (cfg.ok) return await cfg.json();
  } catch { /* no config: use the defaults below */ }
  return {};
}

async function boot() {
  try {
    const cfg = await readConfig();

    // A pinned build names one manifest and gets no picker: an offline bundle
    // has exactly one version in it, and a deliberately pinned page is pinned.
    if (cfg.manifestUrl) {
      await loadVersion(cfg.manifestUrl, null);
      renderPicker();
      return;
    }

    state.versionsUrl = cfg.versionsUrl || DEFAULT_VERSIONS;
    const index = await loadIndex(state.versionsUrl);
    if (index) {
      state.index = index;
      const entry = defaultVersion(index);
      if (!entry) throw new Error(t().fatal.noVersions);
      await loadVersion(new URL(entry.manifest, new URL(state.versionsUrl, location.href)), entry);
      renderPicker();
      return;
    }

    // No index: a manifest beside the page is the offline-bundle layout.
    await loadVersion(DEFAULT_MANIFEST, null);
    renderPicker();
  } catch (e) {
    fatal(e);
  }
}

function fatal(e) {
  const box = $("fatal");
  box.hidden = false;
  box.textContent = t().fatal.cannotRun(e?.message ?? e);
  document.querySelectorAll(".role").forEach((d) => d.classList.add("disabled"));
  $("go").disabled = true;
}

/** The version index, or null when this site does not publish one. */
async function loadIndex(url) {
  const res = await fetch(url, FRESH).catch(() => null);
  if (!res || !res.ok) return null;
  const index = await res.json();
  if (index.schemaVersion !== 1) {
    throw new Error(`versions.json declares schemaVersion ${index.schemaVersion}, this page reads 1`);
  }
  if (!Array.isArray(index.versions) || index.versions.length === 0) {
    throw new Error(t().fatal.noVersions);
  }
  return index;
}

/** Versions this page will offer, newest first. The spec guarantees the order. */
const offered = () =>
  (state.index?.versions ?? []).filter((v) => state.showPrereleases || !v.prerelease);

/** The newest release, preferring a stable one -- a prerelease is opt-in. */
function defaultVersion(index) {
  return index.versions.find((v) => !v.prerelease) ?? index.versions[0];
}

/**
 * Loads one version and rebuilds everything that depends on it.
 *
 * A version switch is a full reload, not a swap of the module: a different
 * version may declare different inputs, different accepted hashes, different
 * outputs and different artifacts. Files the user already chose are discarded
 * rather than carried over, because a file one version accepts another may
 * refuse, and silently keeping it would let a run start on input this version
 * never approved.
 */
async function loadVersion(manifestUrl, entry) {
  state.files.clear();
  state.lastResults = null;
  $("results").hidden = true;
  $("warnings").hidden = true;
  $("run-status").hidden = true;
  $("fatal").hidden = true;

  const { manifest, tool, bytes, sha256 } = await loadFrom(manifestUrl);
  state.manifestUrl = String(manifestUrl);
  state.version = entry;
  state.wasmBytes = bytes;
  state.tool = normaliseTool(tool);
  state.manifest = manifest;
  state.moduleSha256 = sha256;

  // Optional, and a failure to fetch it is not a failure of the page: it only
  // costs the "matches the verified run" verdict on a result.
  try {
    const ref = await fetch("reference.json", FRESH);
    if (ref.ok) state.reference = await ref.json();
  } catch { /* no reference published; results simply carry no verdict */ }

  // A version with no converter has nothing to ask the user for and nothing to
  // run. Say so plainly and hide both steps rather than showing an empty file
  // picker above a button that cannot do anything.
  const converts = Boolean(tool);
  $("input").hidden = !converts;
  $("run").hidden = !converts;
  $("no-converter").hidden = converts;
  if (!converts) {
    $("no-converter").textContent = t().version.noConverter;
    $("about").hidden = true;
    renderLocalised();
    return;
  }

  buildRoleInputs();
  // The info box doubles as the check's result: it appears only on the far
  // side of the hash match and the verifier, and it is drawn from the
  // manifest, so it says the right thing for any project using this spec.
  $("about").hidden = false;
  // `docs` is the manifest's own link for a human; source.repo is the
  // fallback for a manifest published before that field existed.
  if (manifest.docs) {
    $("repo-link").href = manifest.docs;
  } else if (manifest.source?.repo) {
    $("repo-link").href = `https://github.com/${manifest.source.repo}`;
  }
  renderLocalised();
  updateGo();
}

// --- the version picker ----------------------------------------------------

function renderPicker() {
  const wrap = $("version-wrap");
  const select = $("version");
  const note = $("version-note");
  if (!state.index) {
    // Pinned or offline: there is nothing to choose between. Say which version
    // this is anyway, because "which one am I running" is a fair question.
    wrap.hidden = true;
    note.hidden = !state.manifest?.source?.ref;
    note.textContent = state.manifest?.source?.ref
      ? t().version.pinned(state.manifest.source.ref)
      : "";
    return;
  }

  wrap.hidden = false;
  select.replaceChildren();
  for (const v of offered()) {
    const opt = document.createElement("option");
    opt.value = v.tag;
    // The firmware requirement travels with the version because this is the
    // only place a user learns it: a binary built for a newer ABI hardfaults
    // on device with nothing on screen to explain why.
    const abi = v.requiresAbi
      ? t().version.abi(v.requiresAbi.version, v.requiresAbi.minSize)
      : "";
    opt.textContent = [v.tag, v.prerelease ? t().version.prerelease : "", abi]
      .filter(Boolean).join(" · ");
    select.append(opt);
  }
  if (state.version) select.value = state.version.tag;

  // Only worth offering when there is one to show.
  const anyPre = (state.index.versions ?? []).some((v) => v.prerelease);
  const preWrap = $("prerelease-wrap");
  preWrap.hidden = !anyPre;
  $("prerelease").checked = state.showPrereleases;

  const lines = [];
  if (state.index.retained) lines.push(t().version.retained(state.index.retained));
  note.hidden = lines.length === 0;
  note.replaceChildren();
  if (lines.length) {
    note.append(document.createTextNode(`${lines.join(" ")} `));
    if (state.index.releasesUrl) {
      const a = document.createElement("a");
      a.href = state.index.releasesUrl;
      a.textContent = t().version.olderReleases;
      note.append(a);
    }
  }
}

async function switchVersion(tag) {
  const entry = (state.index?.versions ?? []).find((v) => v.tag === tag);
  if (!entry) return;
  const select = $("version");
  select.disabled = true;
  try {
    await loadVersion(
      new URL(entry.manifest, new URL(state.versionsUrl, location.href)), entry);
  } catch (e) {
    fatal(e);
  } finally {
    select.disabled = false;
    renderPicker();
  }
}

// --- localised rendering ---------------------------------------------------
//
// Everything the language switch has to redraw lives here, so switching is one
// call and cannot leave half the page in the previous language.

function renderLocalised() {
  applyStatic();
  const tool = state.tool;

  // The picker and the heading belong to the page, not to the converter, so
  // they are drawn even for a version that declares no converter at all.
  if (state.manifest) {
    $("title").textContent = t().app.heading(state.manifest.title ?? "");
    document.title = $("title").textContent;
  }
  renderPicker();
  if (!tool) {
    $("no-converter").textContent = t().version.noConverter;
    return;
  }

  const shortTitle = state.manifest?.title ?? localeText(tool.title) ?? "";
  const outNames = tool.outputs.map((o) => o.filename).join(", ");
  // Name the game, not the input role: "Base ROM" is a slot in this page's own
  // vocabulary and means nothing to someone who just wants to convert a game.
  $("lede-text").textContent = t().app.lede(shortTitle, outNames);

  // A single-role project reads better with the role's own name as the section
  // heading ("Your ROM") than with a generic plural.
  $("input-heading").textContent =
    roles().length === 1 ? localeText(roles()[0].label) : t().input.heading;

  $("io-out").textContent = outNames;
  renderIoInput();

  for (const role of roles()) {
    const box = document.getElementById(`role-${role.id}`);
    if (!box) continue;
    const roleLabel = box.querySelector(".role-label");
    if (roleLabel) roleLabel.textContent = localeText(role.label);
    const opt = box.querySelector(".role-optional");
    if (opt) opt.textContent = t().input.optional;
    // The manifest owns this copy. The page used to override it with its own
    // hint string, which meant a project could not change what its inputs say
    // without a page release.
    const desc = box.querySelector(".role-desc");
    if (desc) desc.textContent = localeText(role.description);
    renderRoleHelp(role);
    renderRole(role);
  }

  // Re-render results in the new language rather than leaving stale text.
  if (state.lastResults) showResults(state.lastResults);
}

function renderIoInput() {
  const chosen = allFiles();
  const mark = $("io-in-mark");
  if (chosen.length === 0) {
    const primary = requiredRoles()[0] ?? roles()[0];
    $("io-in").textContent = primary
      ? `${localeText(primary.label)} (${(primary.extensions ?? []).join(", ")})`
      : "";
    mark.textContent = "";
    mark.className = "mark";
    return;
  }
  // Summarise what was supplied rather than echoing file names. The names are
  // already shown against the control that took them, and three long cartridge
  // dumps wrap this box onto several lines for no benefit.
  const parts = [];
  for (const role of roles()) {
    const files = filesFor(role.id);
    if (files.length === 0) continue;
    if (role.repeatable) {
      // Name the variants: which extras went in is the useful fact.
      const named = files.map((f) => localeText(f.variant?.label) || f.name);
      parts.push(named.join(", "));
    } else {
      parts.push(localeText(role.label));
    }
  }
  $("io-in").textContent = parts.join(" + ");
  // One mark for the whole input: everything recognised, or something not.
  const allKnown = chosen.every((c) => c.variant);
  mark.textContent = allKnown ? "✓" : "!";
  mark.className = `mark ${allKnown ? "ok" : "warn"}`;
}

// --- 1. the inputs ---------------------------------------------------------
//
// No landing pads. Each role gets an ordinary button next to the name of what
// was chosen, at the same weight as any other control on the page. Dropping a
// file on a role still works; it just does not advertise itself with a
// permanent dashed box, and shows a cue only while something is over it.

function buildRoleInputs() {
  const host = $("roles");
  host.replaceChildren();

  // With a single role the section heading already names it, so repeating the
  // label directly underneath is noise.
  const showHeads = roles().length > 1;

  for (const role of roles()) {
    const box = document.createElement("div");
    box.className = "role";
    box.id = `role-${role.id}`;

    if (showHeads) {
      const head = document.createElement("div");
      head.className = "role-head";
      const label = document.createElement("span");
      label.className = "role-label";
      head.append(label);
      if (!role.required) {
        const opt = document.createElement("span");
        opt.className = "role-optional";
        head.append(opt);
      }
      // The same disclosure as the one beside the lede, for the same reason: a
      // title attribute is invisible on a touch screen, and the detail here is
      // long enough that it does not belong on the page at rest.
      const why = document.createElement("button");
      why.type = "button";
      why.className = "why";
      why.textContent = "?";
      why.setAttribute("aria-expanded", "false");
      head.append(why);
      box.append(head);

      if (role.repeatable) {
        // The one line that stays on the page: what adding another file buys
        // the user. Everything longer lives behind the "?".
        const desc = document.createElement("p");
        desc.className = "role-desc";
        box.append(desc);
      }

      const help = document.createElement("div");
      help.className = "why-text role-help";
      help.hidden = true;
      box.append(help);
      why.addEventListener("click", () => {
        help.hidden = !help.hidden;
        why.setAttribute("aria-expanded", String(!help.hidden));
      });
    }

    const input = document.createElement("input");
    input.type = "file";
    input.className = "file-input";
    if (role.extensions?.length) input.accept = role.extensions.join(",");

    if (role.repeatable) {
      // Several files at once is the normal case here, so the picker offers
      // it rather than making the user come back for each one.
      input.multiple = true;
      const list = document.createElement("ul");
      list.className = "file-list";
      list.hidden = true;
      const add = document.createElement("button");
      add.type = "button";
      add.className = "add-more";
      box.append(list, add, input);
      add.addEventListener("click", () => input.click());
    } else {
      const row = document.createElement("div");
      row.className = "file-row";
      const choose = document.createElement("button");
      choose.type = "button";
      choose.className = "choose";
      const name = document.createElement("span");
      name.className = "file-name empty";
      row.append(choose, input, name);
      box.append(row);
      choose.addEventListener("click", () => input.click());
    }

    const status = document.createElement("div");
    status.className = "status";
    status.id = `status-${role.id}`;
    status.hidden = true;
    box.append(status);

    host.append(box);

    input.addEventListener("change", (e) => {
      const picked = [...e.target.files];
      // Clearing the control means picking the same file twice in a row still
      // fires a change event, which matters for a role you can re-fill.
      e.target.value = "";
      acceptFiles(role, picked);
    });

    for (const ev of ["dragenter", "dragover"]) {
      box.addEventListener(ev, (e) => { e.preventDefault(); box.classList.add("over"); });
    }
    box.addEventListener("dragleave", (e) => {
      // Moving between children of the box is not leaving it.
      if (!box.contains(e.relatedTarget)) box.classList.remove("over");
    });
    box.addEventListener("drop", (e) => {
      e.preventDefault();
      box.classList.remove("over");
      acceptFiles(role, [...e.dataTransfer.files]);
    });
  }
}

/**
 * Fills a role's "?" panel: what the role is, and which releases it takes.
 *
 * The names come from the variants' own labels, which the manifest carries in
 * the project's words. The page used to infer them from the variant ids with
 * Intl.DisplayNames, which only worked because this project's ids happened to
 * be language codes, and needed a carve-out for the one that was not. Reading
 * the label is both simpler and correct for any project.
 *
 * The hashes sit behind a further disclosure, because a hash is only ever
 * useful to someone holding a file they want to identify.
 */
function renderRoleHelp(role) {
  const box = document.getElementById(`role-${role.id}`);
  const help = box?.querySelector(".role-help");
  if (!help) return;
  const s = t().input;

  const why = box.querySelector(".role-head .why");
  if (why) {
    why.title = s.help ?? "";
    why.setAttribute("aria-label", `${s.help ?? ""}: ${localeText(role.label)}`);
  }

  help.replaceChildren();
  // The description is already on the row for a repeatable role, so restating
  // it here would be the same fact twice.
  if (!role.repeatable) {
    const about = document.createElement("p");
    about.className = "help-line";
    about.textContent = localeText(role.description);
    help.append(about);
  }

  const variants = role.variants ?? [];
  if (role.repeatable && variants.length) {
    const named = variants.map((v) => localeText(v.label)).filter(Boolean);
    if (named.length) {
      const line = document.createElement("p");
      line.className = "help-line";
      line.textContent = `${s.accepted ?? ""} ${named.join(", ")}.`;
      help.append(line);
    }
  }

  if (variants.length === 1) {
    // One accepted release: the hash is short enough to just show. Wrapping a
    // single value in a "reveal" is ceremony, not restraint.
    const line = document.createElement("p");
    line.className = "help-line";
    const code = document.createElement("code");
    code.textContent = variants[0].sha1;
    line.append("SHA-1 ", code);
    help.append(line);
  } else if (variants.length) {
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = s.showHashes ?? "";
    const list = document.createElement("ul");
    list.className = "hash-list";
    for (const v of variants) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = localeText(v.label);
      const code = document.createElement("code");
      code.textContent = v.sha1;
      li.append(name, code);
      list.append(li);
    }
    det.append(sum, list);
    help.append(det);
  }
}

/** Redraws one role's list, chosen-file name and control labels. */
function renderRole(role) {
  const box = document.getElementById(`role-${role.id}`);
  if (!box) return;
  const got = filesFor(role.id);

  if (role.repeatable) {
    const list = box.querySelector(".file-list");
    list.replaceChildren();
    for (const f of got) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = f.name;
      const variant = document.createElement("span");
      variant.className = "file-variant";
      variant.textContent = f.variant ? localeText(f.variant.label) : "";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.textContent = t().input.remove ?? "Remove";
      remove.addEventListener("click", () => removeFile(role, f));
      li.append(name, variant, remove);
      list.append(li);
    }
    list.hidden = got.length === 0;
    box.querySelector(".add-more").textContent = t().input.addFile ?? t().input.choose;
    return;
  }

  const name = box.querySelector(".file-name");
  name.textContent = got[0] ? got[0].name : (t().input.none ?? "");
  name.classList.toggle("empty", !got[0]);
  box.querySelector(".choose").textContent = t().input.choose;
  if (got[0]) renderFileStatus(role, got[0]);
}

function renderFileStatus(role, got) {
  const status = document.getElementById(`status-${role.id}`);
  if (got.variant) {
    setStatus(status, "ok", t().input.recognised(got.name, localeText(got.variant.label)));
  } else {
    // Not strict, or it would have been refused before reaching here: almost
    // always a modified ROM, which by definition cannot match a known hash.
    // Accept it and say what was assumed. If it is not the right game at all,
    // the conversion fails on its own.
    setStatus(status, "warn", t().input.unrecognised(got.name, localeText(role.label)));
  }
}

/**
 * Why a file cannot fill this role, or null if it can. These are decisions,
 * not settings: every one of them has a single right answer, so the page makes
 * it and says what it did rather than offering a control.
 *
 * Whether an unrecognised file is refused at all is the manifest's call, via
 * the role's `strict`, and enforcing it is this page's job rather than the
 * module's: the host has the file, the hashes and the user in front of it.
 */
function refusalFor(role, got) {
  const s = t().input;
  const existing = filesFor(role.id);
  if (role.repeatable && existing.some((f) => f.sha1 === got.sha1)) {
    return (s.alreadyAdded ?? ((n) => `${n} has already been added.`))(got.name);
  }
  // The same file is meaningful in another role, so name that role rather than
  // calling a perfectly good ROM unrecognised.
  const other = roles().find(
    (r) => r.id !== role.id && (r.variants ?? []).some((v) => v.sha1 === got.sha1));
  if (other) {
    return (s.wrongRole ?? ((n, o, r) => `${n} is the ${o}, not the ${r}.`))(
      got.name, localeText(other.label), localeText(role.label));
  }
  if (!got.variant && isStrict(role)) {
    const variants = role.variants ?? [];
    // With one acceptable file, name it and its hash outright. With a dozen,
    // the list belongs behind the "?" and the message points at it; either
    // way the user is told what their own file hashed to, which is the part
    // that tells them what they are actually holding.
    if (variants.length === 1) {
      return (s.notTheOne ?? ((n, v, e, a) => `${n} is not ${v} (${e}); it hashes to ${a}.`))(
        got.name, localeText(variants[0].label), variants[0].sha1, got.sha1);
    }
    return (s.notRecognised ?? ((n, r, a) => `${n} is not a supported ${r}; it hashes to ${a}.`))(
      got.name, localeText(role.label), got.sha1);
  }
  // A module that keys its extras by variant refuses a second file for one it
  // already has, so refuse it up front rather than spending a run to find out.
  // Variant id, because it is the only identity the manifest gives a variant;
  // two releases the project considers the same thing carry different ids and
  // both get through here, and the module refuses that pair with its own
  // message.
  const dup = role.repeatable && got.variant?.id
    && existing.some((f) => f.variant?.id === got.variant.id);
  if (dup) {
    return (s.variantAlreadyAdded ?? ((v) => `${v} has already been added.`))(
      localeText(got.variant.label));
  }
  return null;
}

function removeFile(role, got) {
  const left = filesFor(role.id).filter((f) => f !== got);
  if (left.length) state.files.set(role.id, left);
  else state.files.delete(role.id);
  const status = document.getElementById(`status-${role.id}`);
  if (status) status.hidden = true;
  renderRole(role);
  renderIoInput();
  updateGo();
}

async function acceptFiles(role, files) {
  const status = document.getElementById(`status-${role.id}`);
  if (!files.length) return;

  for (const file of files) {
    if (role.maxBytes && file.size > role.maxBytes) {
      setStatus(status, "bad", t().input.tooLarge(file.name));
      continue;
    }

    setStatus(status, "busy", t().input.reading(file.name));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha1 = (await digest("SHA-1", bytes)).toUpperCase();
    const variant = (role.variants ?? []).find((v) => v.sha1 === sha1) ?? null;
    const got = { bytes, sha1, name: file.name, variant };

    const refusal = refusalFor(role, got);
    if (refusal) {
      // A refused file is not held on to: nothing is stored, so the Convert
      // button stays where it was and the page cannot be talked into running
      // on a file it just said no to.
      setStatus(status, "warn", refusal);
      continue;
    }

    if (!role.repeatable) {
      // One file, replacing whatever was there.
      state.files.set(role.id, [got]);
      renderFileStatus(role, got);
      continue;
    }
    state.files.set(role.id, [...filesFor(role.id), got]);
    // The list itself now says what was added, so the status line has nothing
    // left to report.
    status.hidden = true;
  }

  renderRole(role);
  renderIoInput();
  updateGo();
}

function updateGo() {
  const ready = state.tool
    && requiredRoles().every((r) => filesFor(r.id).length > 0);
  $("go").disabled = !ready;
}

// --- 2. run ----------------------------------------------------------------

function progressBar() {
  const wrap = document.createElement("div");
  wrap.className = "bar";
  const fill = document.createElement("div");
  wrap.append(fill);
  return { wrap, fill };
}

async function run() {
  const status = $("run-status");
  const results = $("results");
  const warnList = $("warnings");
  results.hidden = warnList.hidden = true;
  warnList.replaceChildren();
  $("downloads").replaceChildren();
  $("go").disabled = true;
  state.lastResults = null;

  const { wrap, fill } = progressBar();
  status.hidden = false;
  status.className = "status busy";
  status.replaceChildren(document.createTextNode(t().run.starting), wrap);

  // Registration order follows the manifest's role order, but the module
  // identifies each file by content, so the order is a convenience only.
  const ordered = allFiles();
  const worker = new Worker("worker.js", { type: "module" });
  // The ABI has no cancel flag, so this is what a timeout means: stop the
  // thread the module is running on.
  const timer = setTimeout(() => {
    worker.terminate();
    setStatus(status, "bad", t().run.timedOut);
    updateGo();
  }, RUN_TIMEOUT_MS);

  worker.onmessage = async (ev) => {
    const m = ev.data;
    if (m.type === "progress") {
      const pct = Math.round((m.stage / m.stages) * 100);
      fill.style.width = `${pct}%`;
      status.firstChild.textContent = t().run.progress(pct, m.name, m.stage + 1, m.stages);
      return;
    }
    clearTimeout(timer);
    worker.terminate();
    updateGo();

    if (m.type === "error") {
      setStatus(status, "bad", m.message);
      return;
    }

    // The manifest states a ceiling per output as well as one for the run as a
    // whole, and a host is expected to hold the module to both. The tool-level
    // ceiling is enforced inside the worker; this is the per-output one.
    const over = oversizedOutput(m.outputs);
    if (over) {
      setStatus(status, "bad", t().run.tooBig(over.name, over.size, over.max));
      return;
    }

    state.lastResults = m;
    await showResults(m);
  };

  worker.postMessage({
    wasmBytes: state.wasmBytes,
    inputs: ordered.map((f) => f.bytes),
    // No flags. Admission is settled before the run, by `strict` above, and
    // an option a project declares would be read from the manifest.
    flags: 0,
    expectedOutputs: state.tool.outputs.map((o) => o.filename),
    maxOutputBytes: state.tool.limits?.maxOutputBytes,
  });
}

/** The first output larger than the manifest says it may be, or null. */
function oversizedOutput(outputs) {
  for (const out of outputs) {
    const declared = state.tool.outputs.find((o) => o.filename === out.name);
    const max = declared?.maxBytes;
    const size = out.data.byteLength ?? out.data.length;
    if (max && size > max) return { name: out.name, size, max };
  }
  return null;
}

// --- 3. results ------------------------------------------------------------

/**
 * The target this converter feeds. A manifest may declare several; the one
 * that matters here is whichever one says it uses this tool.
 */
function targetForTool() {
  const targets = state.manifest?.targets ?? [];
  const id = state.tool?.id;
  return targets.find((tg) => (tg.uses ?? []).some((u) => u.tool === id)) ?? targets[0] ?? null;
}

/**
 * Everything the install needs, as one file: the artifacts the project
 * published plus the outputs this run produced. The spec defines exactly this
 * set -- every artifact, plus the declared outputs of every tool the target
 * uses -- so nothing here is a judgement call about what belongs.
 *
 * Flat, no directories: where these files go on the card is the installer's
 * decision and differs between firmware versions, so a zip that guessed would
 * be wrong somewhere.
 */
async function buildInstallZip(outputs) {
  const target = targetForTool();
  if (!target) throw new Error("manifest declares no target");

  const entries = [];
  for (const artifact of target.artifacts ?? []) {
    const url = new URL(artifact.url, new URL(state.manifestUrl, location.href));
    const res = await fetch(url, FRESH);
    if (!res.ok) throw new Error(t().zip.fetchFailed(artifact.filename, res.status));
    const data = new Uint8Array(await res.arrayBuffer());

    // A mirror is not a trust boundary. The manifest says how big each file is
    // and what it hashes to, and a file that disagrees does not go in the zip:
    // shipping it would hand someone a broken install with our name on it.
    if (artifact.bytes && data.length !== artifact.bytes) {
      throw new Error(t().zip.sizeMismatch(artifact.filename, data.length, artifact.bytes));
    }
    if (artifact.sha256 && (await digest("SHA-256", data)) !== artifact.sha256) {
      throw new Error(t().zip.hashMismatch(artifact.filename));
    }
    entries.push({ name: artifact.filename, data });
  }

  // Only the outputs this target actually installs. A tool may produce more
  // than a given target uses.
  const wanted = new Set();
  for (const use of target.uses ?? []) {
    if (use.tool !== state.tool.id) continue;
    for (const id of use.outputs ?? []) {
      const declared = state.tool.outputs.find((o) => o.id === id);
      if (declared) wanted.add(declared.filename);
    }
  }
  for (const out of outputs) {
    if (wanted.size === 0 || wanted.has(out.name)) {
      entries.push({ name: out.name, data: new Uint8Array(out.data) });
    }
  }

  return makeZip(entries);
}

/** `<project>-<tag>-gwrg.zip`, or a sensible name when the tag is unknown. */
function zipName() {
  const project = state.manifest?.project ?? "install";
  const tag = state.version?.tag ?? state.manifest?.source?.ref ?? "";
  return [project, tag, "gwrg"].filter(Boolean).join("-") + ".zip";
}

async function showResults({ outputs, warnings }) {
  const status = $("run-status");
  const warnList = $("warnings");
  const results = $("results");
  setStatus(status, "ok", t().run.done(outputs.length));

  warnList.replaceChildren();
  if (warnings.length) {
    warnList.hidden = false;
    for (const w of warnings) {
      const li = document.createElement("li");
      li.textContent = w;                       // module-supplied: text, never markup
      warnList.append(li);
    }
  }

  const reference = state.reference;
  const list = $("downloads");
  list.replaceChildren();
  for (const out of outputs) {
    const data = new Uint8Array(out.data);
    const sha256 = await digest("SHA-256", data);

    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
    a.download = out.name;
    a.textContent = t().results.download(out.name);
    const meta = document.createElement("div");
    meta.className = "meta";

    // What the file is, in the project's own words. The link says the name the
    // user has to put on the card; this says what it is for, and only the
    // project knows that.
    const declared = state.tool.outputs.find((o) => o.filename === out.name);
    const outLabel = localeText(declared?.label);
    if (outLabel) {
      const what = document.createElement("span");
      what.className = "out-label";
      what.textContent = outLabel;
      meta.append(what, " · ");
    }

    // If this repo published the hashes of a verified reference run, and the
    // user gave the same inputs, the output should match exactly. The verdict
    // is the part that means anything to a reader; the hash itself is 64
    // characters of noise until someone actually wants to compare it, so it
    // stays behind a click.
    const expected = matchesReferenceInput(reference)
      ? reference.outputs.find((o) => o.name === out.name)
      : null;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "hash-toggle";
    if (!expected) {
      toggle.textContent = t().results.hash;
    } else if (expected.sha256 === sha256) {
      toggle.textContent = t().results.hashMatches;
      toggle.classList.add("ok");
    } else {
      toggle.textContent = t().results.hashDiffers;
      toggle.classList.add("bad");
    }

    const hash = document.createElement("code");
    hash.className = "hash-value";
    hash.hidden = true;
    hash.textContent = sha256;
    toggle.addEventListener("click", () => { hash.hidden = !hash.hidden; });

    meta.append(`${t().results.bytes(data.length)} · `, toggle, hash);

    li.append(a, meta);
    list.append(li);
  }

  renderZipOffer(outputs);
  results.hidden = false;
}

/**
 * The whole install as one download. The converted file on its own is only
 * half of what a user needs, and the other half is already described by the
 * manifest -- so offering them separately makes the user do a lookup the page
 * could do for them.
 */
function renderZipOffer(outputs) {
  const wrap = $("zip-wrap");
  const button = $("zip");
  const status = $("zip-status");
  const target = targetForTool();
  const artifacts = target?.artifacts ?? [];

  // With nothing published alongside, the zip would hold exactly what the
  // download above already gives.
  if (artifacts.length === 0) {
    wrap.hidden = true;
    return;
  }

  wrap.hidden = false;
  status.hidden = true;
  button.disabled = false;
  button.textContent = t().zip.button;
  $("zip-note").textContent = t().zip.note(
    [...artifacts.map((a) => a.filename), ...outputs.map((o) => o.name)].join(", "));

  button.onclick = async () => {
    button.disabled = true;
    setStatus(status, "busy", t().zip.building);
    try {
      const blob = await buildInstallZip(outputs);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = zipName();
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus(status, "ok", t().zip.ready(a.download, blob.size));
    } catch (e) {
      setStatus(status, "bad", t().zip.failed(e?.message ?? e));
    } finally {
      button.disabled = false;
    }
  };
}

/** True when the files the user supplied are the ones the reference run used. */
function matchesReferenceInput(reference) {
  if (!reference) return false;
  // Spec 1 references record either a single `input` or a list of `inputs`.
  const want = reference.inputs ?? (reference.input ? [reference.input] : []);
  if (want.length === 0) return false;
  const got = allFiles().map((f) => f.sha1).sort();
  const expect = want.map((i) => i.sha1).sort();
  return got.length === expect.length && got.every((h, i) => h === expect[i]);
}

// --- wiring ----------------------------------------------------------------

const langSelect = $("lang");
for (const l of SUPPORTED) {
  const opt = document.createElement("option");
  opt.value = l.code;
  opt.textContent = l.label;          // languages are named in their own language
  langSelect.append(opt);
}
langSelect.value = locale();
langSelect.addEventListener("change", (e) => setLocale(e.target.value));

$("go").addEventListener("click", run);
$("version").addEventListener("change", (e) => switchVersion(e.target.value));
$("prerelease").addEventListener("change", (e) => {
  state.showPrereleases = e.target.checked;
  renderPicker();
});

// The "?" is a disclosure, not a tooltip: it has to work on a touch screen.
const why = $("why");
why.addEventListener("click", () => {
  const box = $("why-text");
  box.hidden = !box.hidden;
  why.setAttribute("aria-expanded", String(!box.hidden));
});

onLocaleChange(renderLocalised);
document.documentElement.lang = locale();
boot();
