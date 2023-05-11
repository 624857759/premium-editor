import * as monaco from 'monaco-editor'

import solhint from 'solhint'
import solium from 'solium'

import solhintRules from './solhint.json'
import soliumRules from './soliumrc.json'
import snippets from './snippets.json'
import SolidityDefinitionProvider from './SolidityDefinitionProvider'

const severityTypes = {
  2: 'error',
  3: 'warning',
}

function lint (code, option) {
  if (option.linter === 'solhint') {
    return runSolhint(code, option)
  } else if (option.linter === 'solium') {
    return runSolium(code, option)
  }
}

function runSolhint (code, option) {
  const rules = { ...solhintRules.rules }
  if (option.solcVersion) {
    rules['compiler-version'] = ['error', option.solcVersion]
  }
  const result = solhint.processStr(code, { rules })
  return result.reports.map(item => ({
    type: severityTypes[item.severity],
    row: item.line,
    column: item.column + 1,
    text: item.message,
  }))
}

function runSolium (code, option) {
  let result
  try {
    result = solium.lint(code, soliumRules)
  } catch (e) {
    console.warn(e)
    return [{
      type: 'error',
      row: e.location.start.line,
      column: e.location.start.column,
      text: e.message,
    }]
  }
  return result.map(item => ({
    type: item.type,
    row: item.line,
    column: item.column + 1,
    text: item.message
  }))
}

function installSupport () {
  monaco.languages.registerCompletionItemProvider('solidity', {
    provideCompletionItems() {
      return {
        suggestions: snippets,
        dispose () {},
      }
    }
  })

  monaco.languages.registerDefinitionProvider('solidity', new SolidityDefinitionProvider())
}

export default {
  lint,
  installSupport,
} 