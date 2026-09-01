'use strict'

const {
  MAX_LENGTH,
  MAX_SAFE_BUILD_LENGTH,
  WHITESPACE_CHARACTERS,
} = require('./constants')

// One entry per UTF-16 code unit keeps membership checks constant-time.
const whitespace = new Uint8Array(0x10000)
for (const char of WHITESPACE_CHARACTERS) {
  whitespace[char.charCodeAt(0)] = 1
}
const isWhitespace = char => whitespace[char && char.charCodeAt(0)] === 1

const isVersionPrefix = char =>
  char === 'v' ||
  char === '=' ||
  isWhitespace(char)

const isDigit = char => char >= '0' && char <= '9'
const isLetter = char =>
  (char >= 'a' && char <= 'z') ||
  (char >= 'A' && char <= 'Z')
const isIdentifierCharacter = char => isDigit(char) || isLetter(char) || char === '-'
const isVersionStart = char =>
  isDigit(char) ||
  char === 'x' ||
  char === 'X' ||
  char === '*'

const scanDigits = (range, start, limit, digitRuns) => {
  if (!isDigit(range[start])) {
    return start
  }
  if (start >= digitRuns.start && start < digitRuns.end) {
    return Math.min(start + limit, digitRuns.end)
  }
  if (start >= digitRuns.previousStart && start < digitRuns.previousEnd) {
    return Math.min(start + limit, digitRuns.previousEnd)
  }
  let end = start + 1
  while (isDigit(range[end])) {
    end++
  }
  // A failed full version can rewind from its second run to its first.
  digitRuns.previousStart = digitRuns.start
  digitRuns.previousEnd = digitRuns.end
  digitRuns.start = start
  digitRuns.end = end
  return Math.min(start + limit, end)
}

const scanNumeric = (range, start, loose, digitRuns) => {
  if (!loose && range[start] === '0') {
    return start + 1
  }
  return scanDigits(range, start, loose ? MAX_LENGTH : MAX_LENGTH + 1, digitRuns)
}

const scanPrereleaseIdentifier = (range, start, loose, digitRuns) => {
  const digitsEnd = scanDigits(range, start, MAX_LENGTH, digitRuns)
  if (isLetter(range[digitsEnd]) || range[digitsEnd] === '-') {
    let end = digitsEnd + 1
    const limit = end + MAX_SAFE_BUILD_LENGTH
    while (end < limit && isIdentifierCharacter(range[end])) {
      end++
    }
    return end
  }
  return scanNumeric(range, start, loose, digitRuns)
}

const scanPrerelease = (range, start, loose, digitRuns) => {
  const hyphen = range[start] === '-'
  if (!loose && !hyphen) {
    return start
  }
  const identifierStart = start + (hyphen ? 1 : 0)
  let end = scanPrereleaseIdentifier(range, identifierStart, loose, digitRuns)
  if (end === identifierStart) {
    if (!loose || !hyphen) {
      return start
    }
    // In loose syntax, a lone hyphen can itself be the identifier.
    end = scanPrereleaseIdentifier(range, start, loose, digitRuns)
  }
  while (range[end] === '.') {
    const next = scanPrereleaseIdentifier(range, end + 1, loose, digitRuns)
    if (next === end + 1) {
      break
    }
    end = next
  }
  return end
}

const scanBuildIdentifier = (range, start) => {
  let end = start
  while (end - start < MAX_SAFE_BUILD_LENGTH && isIdentifierCharacter(range[end])) {
    end++
  }
  return end
}

const scanBuild = (range, start) => {
  if (range[start] !== '+') {
    return start
  }
  let end = scanBuildIdentifier(range, start + 1)
  if (end === start + 1) {
    return start
  }
  while (range[end] === '.') {
    const next = scanBuildIdentifier(range, end + 1)
    if (next === end + 1) {
      break
    }
    end = next
  }
  return end
}

const scanFullVersion = (range, start, digitRuns) => {
  let end = start
  for (let component = 0; component < 3; component++) {
    const next = scanNumeric(range, end, true, digitRuns)
    if (next === end) {
      return start
    }
    end = next
    if (component < 2) {
      if (range[end] !== '.') {
        return start
      }
      end++
    }
  }
  return scanBuild(range, scanPrerelease(range, end, true, digitRuns))
}

const scanXIdentifier = (range, start, digitRuns) => {
  if (isDigit(range[start])) {
    return scanNumeric(range, start, false, digitRuns)
  }
  return isVersionStart(range[start]) ? start + 1 : start
}

const scanVersion = (range, start, digitRuns) => {
  // Full loose versions take precedence over partial and wildcard versions.
  const full = scanFullVersion(range, start, digitRuns)
  if (full !== start) {
    return full
  }
  let end = scanXIdentifier(range, start, digitRuns)
  for (let component = 0; component < 2; component++) {
    if (range[end] !== '.') {
      return end
    }
    const next = scanXIdentifier(range, end + 1, digitRuns)
    if (next === end + 1) {
      return end
    }
    end = next
  }
  return scanBuild(range, scanPrerelease(range, end, false, digitRuns))
}

// Consume the complete version before scanning another comparator, so a
// trailing v in its prerelease cannot become the next version's prefix.
const trimComparatorWhitespace = range => {
  let result = ''
  let position = 0
  let index = 0
  const digitRuns = { start: -1, end: -1, previousStart: -1, previousEnd: -1 }

  while (index < range.length) {
    const start = index
    if (range[index] === '<' || range[index] === '>') {
      index++
    } else if (!isVersionPrefix(range[index]) && !isVersionStart(range[index])) {
      index++
      continue
    }

    // Skip prefixes without a version once, not once per possible start.
    while (index < range.length && isVersionPrefix(range[index])) {
      index++
    }
    if (!isVersionStart(range[index])) {
      continue
    }

    let trimStart = start
    if (isWhitespace(range[trimStart])) {
      trimStart++
    }
    if (range[trimStart] === '<' || range[trimStart] === '>') {
      trimStart++
    }
    if (range[trimStart] === '=') {
      trimStart++
    }
    const trimEnd = trimStart + (isWhitespace(range[trimStart]) ? 1 : 0)
    if (trimStart !== trimEnd) {
      result += range.slice(position, trimStart)
      position = trimEnd
    }
    index = scanVersion(range, index, digitRuns)
  }

  return result + range.slice(position)
}

module.exports = trimComparatorWhitespace
