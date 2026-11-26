/**
 * layers.js — the configuration layers and how they combine (F-136 D4).
 *
 * A layer is `{ file, pointer, patch }`: the file it comes from, the JSON
 * pointer (RFC 6901) of the patch inside that file (`''` for the top level),
 * and the patch. `applyLayers` patches them over `{}` in order by JSON Merge
 * Patch (RFC 7396), with the `json-merge-patch` library (D-86). Two orders
 * exist:
 *
 *   - both axes (`bothAxes`, with `reposLayers` below it for the shape
 *     check), for `backlog.yaml` and the operator's `config.yaml` (core.md,
 *     "The layer order", D-87);
 *   - the who axis only (`whoAxis`, `whoEntries`), for the files for people
 *     (views.md, D-471).
 *
 * A source here is a file as read: `{ file, value }`, or `null` when the file
 * is not there. A missing file is no layer, not a fault (D3).
 */

import mergePatch from 'json-merge-patch';
import { isMapping, pointerToken } from './files.js';

/**
 * @typedef {object} Layer
 * @property {string} file     the file the patch comes from
 * @property {string} pointer  the JSON pointer of the patch in that file
 * @property {unknown} patch   the JSON Merge Patch
 */

/**
 * @typedef {{ file: string, value: Record<string, any> } | null} Source
 */

/**
 * The layers patched in order over `{}`. `json-merge-patch`'s `apply` changes
 * its target in place and puts the patch's own lists and objects into it, so
 * each patch is cloned first: the result shares nothing with the inputs.
 * @param {Layer[]} layers
 * @returns {unknown}
 */
export function applyLayers(layers) {
  return layers.reduce((result, layer) => mergePatch.apply(result, structuredClone(layer.patch)), {});
}

/** A source's top level without its `repos` key, as a layer. */
function topLayer(source) {
  const { repos, ...rest } = source.value;
  return { file: source.file, pointer: '', patch: rest };
}

/**
 * A source's `repos` mapping, or `{}` when it has none or it is not a
 * mapping (the shape check reports that, D5).
 * @param {Source} source
 * @returns {Record<string, unknown>}
 */
function reposOf(source) {
  const repos = source?.value.repos;
  return isMapping(repos) ? repos : {};
}

/**
 * A source's `repos.<repo>` entry as a layer, or nothing when it has none or
 * it is not a mapping (the shape check reports that, D5).
 */
function repoLayers(source, repo) {
  const repos = reposOf(source);
  if (!isMapping(repos[repo])) return [];
  return [{ file: source.file, pointer: `/repos/${pointerToken(repo)}`, patch: repos[repo] }];
}

/**
 * The both-axes order (D-87). For work in `repo`: the shop's top level, the
 * shop's `repos.<repo>`, the operator's top level, the operator's
 * `repos.<repo>`. With `repo` `null` (work outside any repo): the two top
 * levels. Each top-level layer leaves out the `repos` key.
 * @param {Source} shop
 * @param {Source} operator
 * @param {string|null} repo
 * @returns {Layer[]}
 */
export function bothAxes(shop, operator, repo) {
  return [shop, operator]
    .filter((source) => source !== null)
    .flatMap((source) => [topLayer(source), ...(repo === null ? [] : repoLayers(source, repo))]);
}

/**
 * The `repos` key of each source that has one, as a layer of its own: the
 * shop's, then the operator's. The loader puts these below the both-axes
 * layers of every scope, so each scope's result holds the merged `repos` map
 * and the shape check sees it (D5); `bothAxes` leaves `repos` out (D-87).
 * @param {Source} shop
 * @param {Source} operator
 * @returns {Layer[]}
 */
export function reposLayers(shop, operator) {
  return [shop, operator]
    .filter((source) => source !== null && Object.hasOwn(source.value, 'repos'))
    .map((source) => ({ file: source.file, pointer: '', patch: { repos: source.value.repos } }));
}

/**
 * The scopes of the both-axes order: `null` (the top level), then each repo
 * name of the merged `repos` map, sorted. A repo that the operator deletes
 * with `null` is no scope, so no layer of it reaches a result.
 * @param {Source} shop
 * @param {Source} operator
 * @returns {(string|null)[]}
 */
export function scopesOf(shop, operator) {
  const repos = /** @type {any} */ (applyLayers(reposLayers(shop, operator))).repos;
  return [null, ...Object.keys(isMapping(repos) ? repos : {}).sort()];
}

/**
 * The who-axis order of one file (D-471): the shop's file, then the
 * operator's file of the same relative name, each whole. No repo layer.
 * @param {Source} shop
 * @param {Source} operator
 * @returns {Layer[]}
 */
export function whoAxis(shop, operator) {
  return [shop, operator]
    .filter((source) => source !== null)
    .map((source) => ({ file: source.file, pointer: '', patch: source.value }));
}

/**
 * The who-axis order of a directory kind (`config/templates/`,
 * `config/color-schemes/`): each file name is its own entry, with the layers
 * of `whoAxis`. A name in only one directory is that file alone, so an
 * operator file with a new name adds an entry.
 * @param {Record<string, Source>} shop      file name → the shop's file
 * @param {Record<string, Source>} operator  file name → the operator's file
 * @returns {Record<string, Layer[]>} file name → its layers, names sorted
 */
export function whoEntries(shop, operator) {
  const names = [...new Set([...Object.keys(shop), ...Object.keys(operator)])].sort();
  return Object.fromEntries(names.map((name) => [name, whoAxis(shop[name] ?? null, operator[name] ?? null)]));
}
