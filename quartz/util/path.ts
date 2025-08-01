import { slug as slugAnchor } from 'github-slugger'
import type { Element as HastElement } from 'hast'
import { clone } from './clone'

// this file must be isomorphic so it can't use node libs (e.g. path)

export const QUARTZ = 'quartz'

/// Utility type to simulate nominal types in TypeScript
type SlugLike<T> = string & { __brand: T }

/** Cannot be relative and must have a file extension. */
export type FilePath = SlugLike<'filepath'>
export function isFilePath(s: string): s is FilePath {
  const validStart = !s.startsWith('.')
  return validStart && _hasFileExtension(s)
}

/** Cannot be relative and may not have leading or trailing slashes. It can have `index` as it's last segment. Use this wherever possible is it's the most 'general' interpretation of a slug. */
export type FullSlug = SlugLike<'full'>
export function isFullSlug(s: string): s is FullSlug {
  const validStart = !(s.startsWith('.') || s.startsWith('/'))
  const validEnding = !s.endsWith('/')
  return validStart && validEnding && !containsForbiddenCharacters(s)
}

/** Shouldn't be a relative path and shouldn't have `/index` as an ending or a file extension. It _can_ however have a trailing slash to indicate a folder path. */
export type SimpleSlug = SlugLike<'simple'>
export function isSimpleSlug(s: string): s is SimpleSlug {
  const validStart = !(s.startsWith('.') || (s.length > 1 && s.startsWith('/')))
  const validEnding = !endsWith(s, 'index')
  return validStart && !containsForbiddenCharacters(s) && validEnding && !_hasFileExtension(s)
}

/** Can be found on `href`s but can also be constructed for client-side navigation (e.g. search and graph) */
export type RelativeURL = SlugLike<'relative'>
export function isRelativeURL(s: string): s is RelativeURL {
  const validStart = /^\.{1,2}/.test(s)
  const validEnding = !endsWith(s, 'index')
  return validStart && validEnding && !['.md', '.html'].includes(getFileExtension(s) ?? '')
}

export function isAbsoluteURL(s: string): boolean {
  try {
    new URL(s)
  } catch {
    return false
  }
  return true
}

export function getFullSlug(window: Window): FullSlug {
  const res = window.document.body.dataset.slug! as FullSlug
  return res
}

function sluggify(s: string): string {
  return s
    .split('/')
    .map((segment) =>
      segment
        .replace(/\s/g, '-')
        .replace(/&/g, '-and-')
        .replace(/%/g, '-percent')
        .replace(/\?/g, '')
        .replace(/#/g, ''),
    )
    .join('/') // always use / as sep
    .replace(/\/$/, '')
}

export function slugifyFilePath(fp: FilePath, excludeExt?: boolean): FullSlug {
  fp = stripSlashes(fp) as FilePath
  let ext = getFileExtension(fp)
  const withoutFileExt = fp.replace(new RegExp(ext + '$'), '')
  if (excludeExt || ['.md', '.html', undefined].includes(ext)) {
    ext = ''
  }

  let slug = sluggify(withoutFileExt)

  // treat _index as index
  if (endsWith(slug, '_index')) {
    slug = slug.replace(/_index$/, 'index')
  }

  return (slug + ext) as FullSlug
}

export function simplifySlug(fp: FullSlug): SimpleSlug {
  const res = stripSlashes(trimSuffix(fp, 'index'), true)
  return (res.length === 0 ? '/' : res) as SimpleSlug
}

export function transformInternalLink(link: string): RelativeURL {
  let [fplike, anchor] = splitAnchor(decodeURI(link))

  const folderPath = isFolderPath(fplike)
  let segments = fplike.split('/').filter((x) => x.length > 0)
  let prefix = segments.filter(isRelativeSegment).join('/')
  let fp = segments.filter((seg) => !isRelativeSegment(seg) && seg !== '').join('/')

  // manually add ext here as we want to not strip 'index' if it has an extension
  const simpleSlug = simplifySlug(slugifyFilePath(fp as FilePath))
  const joined = joinSegments(stripSlashes(prefix), stripSlashes(simpleSlug))
  const trail = folderPath ? '/' : ''
  const res = (_addRelativeToStart(joined) + trail + anchor) as RelativeURL
  return res
}

// from micromorph/src/utils.ts
// https://github.com/natemoo-re/micromorph/blob/main/src/utils.ts#L5
const _rebaseHtmlElement = (el: Element, attr: string, newBase: string | URL) => {
  const rebased = new URL(el.getAttribute(attr)!, newBase)
  el.setAttribute(attr, rebased.pathname + rebased.hash)
}
export function normalizeRelativeURLs(el: Element | Document, destination: string | URL) {
  el.querySelectorAll('[href=""], [href^="./"], [href^="../"]').forEach((item) =>
    _rebaseHtmlElement(item, 'href', destination),
  )
  el.querySelectorAll('[src=""], [src^="./"], [src^="../"]').forEach((item) =>
    _rebaseHtmlElement(item, 'src', destination),
  )
}

const _rebaseHastElement = (
  el: HastElement,
  attr: string,
  curBase: FullSlug,
  newBase: FullSlug,
) => {
  if (el.properties?.[attr]) {
    if (!isRelativeURL(String(el.properties[attr]))) {
      return
    }

    const rel = joinSegments(resolveRelative(curBase, newBase), '..', el.properties[attr] as string)
    el.properties[attr] = rel
  }
}

export function normalizeHastElement(rawEl: HastElement, curBase: FullSlug, newBase: FullSlug) {
  const el = clone(rawEl) // clone so we dont modify the original page
  _rebaseHastElement(el, 'src', curBase, newBase)
  _rebaseHastElement(el, 'href', curBase, newBase)
  if (el.children) {
    el.children = el.children.map((child) =>
      normalizeHastElement(child as HastElement, curBase, newBase),
    )
  }

  return el
}

// resolve /a/b/c to ../..
export function pathToRoot(slug: FullSlug): RelativeURL {
  let rootPath = slug
    .split('/')
    .filter((x) => x !== '')
    .slice(0, -1)
    .map((_) => '..')
    .join('/')

  if (rootPath.length === 0) {
    rootPath = '.'
  }

  return rootPath as RelativeURL
}

export function resolveRelative(current: FullSlug, target: FullSlug | SimpleSlug): RelativeURL {
  const res = joinSegments(pathToRoot(current), simplifySlug(target as FullSlug)) as RelativeURL
  return res
}

export function splitAnchor(link: string): [string, string] {
  let [fp, anchor] = link.split('#', 2)
  if (fp.endsWith('.pdf')) {
    return [fp, anchor === undefined ? '' : `#${anchor}`]
  }
  anchor = anchor === undefined ? '' : '#' + slugAnchor(anchor)
  return [fp, anchor]
}

export function slugTag(tag: string) {
  return tag
    .split('/')
    .map((tagSegment) => sluggify(tagSegment))
    .join('/')
}

export function joinSegments(...args: string[]): string {
  if (args.length === 0) {
    return ''
  }

  let joined = args
    .filter((segment) => segment !== '' && segment !== '/')
    .map((segment) => stripSlashes(segment))
    .join('/')

  // if the first segment starts with a slash, add it back
  if (args[0].startsWith('/')) {
    joined = '/' + joined
  }

  // if the last segment is a folder, add a trailing slash
  if (args[args.length - 1].endsWith('/')) {
    joined = joined + '/'
  }

  return joined
}

export function getAllSegmentPrefixes(tags: string): string[] {
  const segments = tags.split('/')
  const results: string[] = []
  for (let i = 0; i < segments.length; i++) {
    results.push(segments.slice(0, i + 1).join('/'))
  }
  return results
}

export interface TransformOptions {
  strategy: 'absolute' | 'relative' | 'shortest'
  allSlugs: FullSlug[]
}

export function transformLink(src: FullSlug, target: string, opts: TransformOptions): RelativeURL {
  let targetSlug = transformInternalLink(target)

  if (opts.strategy === 'relative') {
    return targetSlug as RelativeURL
  } else {
    const folderTail = isFolderPath(targetSlug) ? '/' : ''
    const canonicalSlug = stripSlashes(targetSlug.slice('.'.length))
    let [targetCanonical, targetAnchor] = splitAnchor(canonicalSlug)

    if (opts.strategy === 'shortest') {
      // if the file name is unique, then it's just the filename
      const matchingFileNames = opts.allSlugs.filter((slug) => {
        const parts = slug.split('/')
        const fileName = parts.at(-1)
        return targetCanonical === fileName
      })

      // only match, just use it
      if (matchingFileNames.length === 1) {
        const targetSlug = matchingFileNames[0]
        return (resolveRelative(src, targetSlug) + targetAnchor) as RelativeURL
      }
    }

    // if it's not unique, then it's the absolute path from the vault root
    return (joinSegments(pathToRoot(src), canonicalSlug) + folderTail) as RelativeURL
  }
}

// path helpers
export function isFolderPath(fplike: string): boolean {
  return (
    fplike.endsWith('/') ||
    endsWith(fplike, 'index') ||
    endsWith(fplike, 'index.md') ||
    endsWith(fplike, 'index.html')
  )
}

export function endsWith(s: string, suffix: string): boolean {
  return s === suffix || s.endsWith('/' + suffix)
}

export function trimSuffix(s: string, suffix: string): string {
  if (endsWith(s, suffix)) {
    s = s.slice(0, -suffix.length)
  }
  return s
}

function containsForbiddenCharacters(s: string): boolean {
  return s.includes(' ') || s.includes('#') || s.includes('?') || s.includes('&')
}

function _hasFileExtension(s: string): boolean {
  return getFileExtension(s) !== undefined
}

export function getFileExtension(s: string): string | undefined {
  return s.match(/\.[A-Za-z0-9]+$/)?.[0]
}

function isRelativeSegment(s: string): boolean {
  return /^\.{0,2}$/.test(s)
}

export function stripSlashes(s: string, onlyStripPrefix?: boolean): string {
  if (s.startsWith('/')) {
    s = s.substring(1)
  }

  if (!onlyStripPrefix && s.endsWith('/')) {
    s = s.slice(0, -1)
  }

  return s
}

function _addRelativeToStart(s: string): string {
  if (s === '') {
    s = '.'
  }

  if (!s.startsWith('.')) {
    s = joinSegments('.', s)
  }

  return s
}
