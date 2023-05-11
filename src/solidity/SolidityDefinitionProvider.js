import * as monaco from 'monaco-editor'

import solparse from 'solparse-exp-jb'

import { BaseProjectManager } from '@obsidians/workspace'
import { modelSessionManager } from '@obsidians/code-editor'

class Contract {
  static async import(importPath, model) {
    const filePath = resolveImportPath(importPath, model)
    if (!await BaseProjectManager.instance.isFile(filePath)) {
      return
    }
    return new Contract(filePath)
  }

  constructor (filePath) {
    this.filePath = filePath
    this.imports = []
  }

  get model () {
    return modelSessionManager.newModelSession(this.filePath).then(modelSession => modelSession.model)
  }

  get code () {
    return this.model.then(model => model.getValue())
  }
}

export default class SolidityDefinitionProvider {
  /**
   * Provide definition for cursor position in Solidity codebase. It calculate offset from cursor position and find the
   * most precise statement in solparse AST that surrounds the cursor. It then deduces the definition of the element based
   * on the statement type.
   *
   * @param {monaco.editor.ITextModel} model
   * @param {monaco.Position} position
   * @returns {(Thenable<monaco.languages.LocationLink[]>)}
   * @memberof SolidityDefinitionProvider
   */
  async provideDefinition(
    model,
    position,
  ) {
    const modelText = model.getValue()
    // const contractPath = URI.parse(model.uri).fsPath

    // const contracts = new ContractCollection()
    // if (this.project !== undefined) {
    //   contracts.addContractAndResolveImports(
    //     contractPath,
    //     modelText,
    //     this.project,
    //   )
    // }
    // // this contract
    // const contract = contracts.contracts[0]

    const offset = model.getOffsetAt(position)
    let result
    try {
      result = solparse.parse(modelText)
    } catch (e) {
      if (!e.result) {
        return
      }
      result = e.result
    }
    const element = this.findElementByOffset(result.body, offset)

    const imports = result.body.filter(element => element.type === 'ImportStatement').map(element => element.from)
    const importedContracts = await Promise.all(imports.map(importPath => Contract.import(importPath, model)))
    const contracts = {
      contracts: [
        { code: modelText, model, imports },
        ...importedContracts.filter(Boolean)
      ]
    }
    const contract = contracts.contracts[0]

    if (element !== undefined) {
      switch (element.type) {
        case 'ImportStatement': {
          const filePath = resolveImportPath(element.from, contract.model)
          if (!await BaseProjectManager.instance.isFile(filePath)) {
            return
          }
          const fullRange = monaco.Range.fromPositions(model.getPositionAt(element.start), model.getPositionAt(element.end))
          const fullText = model.getValueInRange(fullRange)
          const index = fullText.indexOf(element.from)
          const range = monaco.Range.fromPositions(
            model.getPositionAt(element.start + index),
            model.getPositionAt(element.start + index + element.from.length)
          )
          return [{
            uri: monaco.Uri.file(filePath),
            range: new monaco.Range(1, 1, 1, 1),
            originSelectionRange: range,
          }]
        }
        case 'ContractStatement': {
          // find definition for inheritance
          const isBlock = this.findElementByOffset(element.is, offset)
          if (isBlock !== undefined) {
            let directImport = await this.findDirectImport(
              model,
              result.body,
              isBlock.name,
              'ContractStatement',
              contracts,
            )

            if (directImport.location === undefined) {
              directImport = await this.findDirectImport(
                model,
                result.body,
                isBlock.name,
                'InterfaceStatement',
                contracts,
              )
            }
            return directImport.location
          }

          // find definition in contract body recursively
          const statement = this.findElementByOffset(element.body, offset)
          if (statement !== undefined) {
            return this.provideDefinitionInStatement(
              model,
              result.body,
              statement,
              element,
              offset,
              contracts,
            )
          }
          break
        }
        case 'LibraryStatement': {
          // find definition in library body recursively
          const statement = this.findElementByOffset(element.body, offset)
          if (statement !== undefined) {
            return this.provideDefinitionInStatement(
              model,
              result.body,
              statement,
              element,
              offset,
              contracts,
            )
          }
          break
        }
        case 'InterfaceStatement': {
          // find definition in interface body recursively
          const statement = this.findElementByOffset(element.body, offset)
          if (statement !== undefined) {
            return this.provideDefinitionInStatement(
              model,
              result.body,
              statement,
              element,
              offset,
              contracts,
            )
          }
          break
        }
        default:
          break
      }
    }
  }

  /**
   * Provide definition for anything other than `import`, and `is` statements by recursively searching through
   * statement and its children.
   *
   * @private
   * @param {monaco.editor.ITextModel} model text model, where statement belongs, used to convert position to/from offset
   * @param {Array<any>} modelStatements array of statements found in the current model
   * @param {*} statement current statement which contains the cursor offset
   * @param {*} parentStatement parent of the current statement
   * @param {number} offset cursor offset of the element we need to provide definition for
   * @param {ContractCollection} contracts collection of contracts resolved by current contract
   * @returns {(Thenable<monaco.languages.LocationLink[]>)}
   * @memberof SolidityDefinitionProvider
   */
  async provideDefinitionInStatement(
    model,
    modelStatements,
    statement,
    parentStatement,
    offset,
    contracts,
  ) {
    switch (statement.type) {
      case 'UsingStatement':
        if (offset < statement.for.start) {
          // definition of the library itself i.e. using **Library** for xxxx
          return await this.findDirectImport(
            model,
            modelStatements,
            statement.library,
            'LibraryStatement',
            contracts,
          ).location
        } else {
          // definition of the using statement target i.e. using Library for **DataType**
          return this.provideDefinitionForType(
            model,
            modelStatements,
            statement.for,
            contracts,
          )
        }
      case 'Type':
        // handle nested type and resolve to inner type when applicable e.g. mapping(uint => Struct)
        if (statement.literal instanceof Object && statement.literal.start <= offset && offset <= statement.literal.end) {
          return this.provideDefinitionInStatement(
            model,
            modelStatements,
            statement.literal,
            statement,
            offset,
            contracts,
          )
        } else {
          return this.provideDefinitionForType(
            model,
            modelStatements,
            statement,
            contracts,
          )
        }
      case 'Identifier':
        switch (parentStatement.type) {
          case 'CallExpression': // e.g. Func(x, y)
            if (parentStatement.callee === statement) {
              // TODO: differentiate function, event, and struct construction
              return this.provideDefinitionForCallee(
                contracts,
                statement.name,
              )
            }
            break
          case 'MemberExpression': // e.g. x.y x.f(y) arr[1] map['1'] arr[i] map[k]
            if (parentStatement.object === statement) {
              // NB: it is possible to have f(x).y but the object statement would not be an identifier
              // therefore we can safely assume this is a variable instead
              return this.provideDefinitionForVariable(
                contracts,
                statement.name,
              )
            } else if (parentStatement.property === statement) {
              return Promise.all([
                // TODO: differentiate better between following possible cases

                // TODO: provide field access definition, which requires us to know the type of object
                // Consider find the definition of object first and recursive upward till declarative expression for type inference

                // array or mapping access via variable i.e. arr[i] map[k]
                this.provideDefinitionForVariable(
                  contracts,
                  statement.name,
                ),
                // func call in the form of obj.func(arg)
                this.provideDefinitionForCallee(
                  contracts,
                  statement.name,
                ),
              ]).then(locationsArray => Array.prototype.concat.apply([], locationsArray))
            }
            break
          default:
            return this.provideDefinitionForVariable(
              contracts,
              statement.name,
            )
        }
        break
      default:
        for (const key in statement) {
          if (statement.hasOwnProperty(key)) {
            const element = statement[key]
            if (element instanceof Array) {
              // recursively drill down to collections e.g. statements, params
              const inner = this.findElementByOffset(element, offset)
              if (inner !== undefined) {
                return this.provideDefinitionInStatement(
                  model,
                  modelStatements,
                  inner,
                  statement,
                  offset,
                  contracts,
                )
              }
            } else if (element instanceof Object) {
              // recursively drill down to elements with start/end e.g. literal type
              if (
                element.hasOwnProperty('start') && element.hasOwnProperty('end') &&
                element.start <= offset && offset <= element.end
              ) {
                return this.provideDefinitionInStatement(
                  model,
                  modelStatements,
                  element,
                  statement,
                  offset,
                  contracts,
                )
              }
            }
          }
        }

        // handle modifier last now that params have not been selected
        if (statement.type === 'ModifierArgument') {
          return this.provideDefinitionForCallee(contracts, statement.name)
        }
        break
    }
  }

  /**
   * Provide definition for a callee which can be a function, event, struct, or contract
   *
   * e.g. f(x), emit Event(x), Struct(x), Contract(address)
   *
   * @private
   * @param {ContractCollection} contracts collection of contracts resolved by current contract
   * @param {string} name name of the variable
   * @returns {Promise<monaco.languages.LocationLink[]>}
   * @memberof SolidityDefinitionProvider
   */
  async provideDefinitionForCallee(
    contracts,
    name,
  ) {
    return await this.provideDefinitionForContractMember(
      contracts,
      (element) => {
        const elements = element.body.filter(contractElement =>
          contractElement.name === name && (
            contractElement.type === 'FunctionDeclaration' ||
            contractElement.type === 'EventDeclaration' ||
            contractElement.type === 'StructDeclaration' ||
            contractElement.type === "EnumDeclaration"
          ),
        )

        if (element.type === 'ContractStatement' && element.name === name) {
          elements.push(element)
        }

        return elements
      }
    )
  }

  /**
   * Provide definition for a variable which can be contract storage variable, constant, local variable (including parameters)
   *
   * TODO: find local variable reference (locally defined, parameters and return parameters)
   * @private
   * @param {ContractCollection} contracts collection of contracts resolved by current contract
   * @param {string} name name of the variable
   * @returns {Promise<monaco.languages.LocationLink[]>}
   * @memberof SolidityDefinitionProvider
   */
  async provideDefinitionForVariable(
    contracts,
    name,
  ) {
    return this.provideDefinitionForContractMember(
      contracts,
      (element) =>
        element.body.filter(contractElement =>
          contractElement.name === name && (contractElement.type === 'StateVariableDeclaration')
        ),
    )
  }

  /**
   * Provide definition for a contract member
   *
   * @private
   * @param {ContractCollection} contracts collection of contracts resolved by current contract
   * @param {string} extractElements extract all relevant elements from a contract or library statement
   * @returns {Promise<monaco.languages.LocationLink[]>}
   * @memberof SolidityDefinitionProvider
   */
  async provideDefinitionForContractMember(
    contracts,
    extractElements,
  ) {
    const locations = []
    for (const contract of contracts.contracts) {
      let result
      try {
        result = solparse.parse(await contract.code)
      } catch (e) {
        if (!e.result) {
          continue
        }
        result = e.result
      }
      const elements = Array.prototype.concat.apply([],
        result.body.map(element => {
          if (element.type === 'ContractStatement' || element.type === 'LibraryStatement') {
            if (typeof element.body !== 'undefined' && element.body !== null) {
              return extractElements(element)
            }
          }
          return []
        }),
      )

      const model = await contract.model
      const uri = model.uri
      elements.forEach(contractElement => {
        const range = monaco.Range.fromPositions(
          model.getPositionAt(contractElement.start),
          model.getPositionAt(contractElement.end)
        )
        return locations.push({ uri, range, targetSelectionRange: range })
      })
    }
    return locations
  }

  /**
   * Provide definition for a type. A type can either be simple e.g. `Struct` or scoped `MyContract.Struct`.
   * For the scoped type, we recurse with the type member as a simple type in the scoped model.
   *
   * @private
   * @param {monaco.editor.ITextModel} model text model, where statement belongs, used to convert position to/from offset
   * @param {Array<any>} modelStatements array of statements found in the current model
   * @param {*} literal type literal object
   * @param {ContractCollection} contracts collection of contracts resolved by current contract
   * @returns {(Thenable<monaco.languages.LocationLink[]>)}
   * @memberof SolidityDefinitionProvider
   */
  async provideDefinitionForType(
    model,
    modelStatements,
    literal,
    contracts,
  ) {
    if (literal.members.length > 0) {
      // handle scoped type by looking for scoping Contract or Library e.g. MyContract.Struct
      let literalDocument = await this.findDirectImport(model, modelStatements, literal.literal, 'ContractStatement', contracts)
      if (literalDocument.location === undefined) {
        literalDocument = await this.findDirectImport(model, modelStatements, literal.literal, 'LibraryStatement', contracts)
      }

      if (literalDocument.location !== undefined) {
        return this.provideDefinitionForType(
          literalDocument.model,
          literalDocument.statements,
          // a fake literal that uses the inner name and set start to the contract location
          {
            literal: literal.members[0],
            members: [],
            start: literalDocument.model.offsetAt(literalDocument.location.range.start),
          },
          contracts,
        )
      }
    } else {
      const contractStatement = this.findElementByOffset(modelStatements, literal.start)
      const structLocation = this.findStatementLocationByNameType(
        model,
        contractStatement.body,
        literal.literal,
        'StructDeclaration',
      )
      if (structLocation !== undefined) {
        return await structLocation
      }

      const enumLocation = this.findStatementLocationByNameType(
        model,
        contractStatement.body,
        literal.literal,
        'EnumDeclaration',
      )
      if (enumLocation !== undefined) {
        return await enumLocation
      }

      // TODO: only search inheritance chain
      return this.provideDefinitionForContractMember(
        contracts,
        (element) =>
          element.body.filter(contractElement =>
            contractElement.name === literal.literal && (contractElement.type === 'StructDeclaration' || contractElement.type === 'EnumDeclaration'),
          ),
      )
    }
  }

  /**
   * Find the first statement by name and type in current model and its direct imports.
   *
   * This is used to find either Contract or Library statement to define `is`, `using`, or member accessor.
   *
   * @private
   * @param {monaco.editor.ITextModel} model model where statements belong, used to convert offset to position
   * @param {Array<any>} statements list of statements to search through
   * @param {string} name name of statement to find
   * @param {string} type type of statement to find
   * @param {ContractCollection} contracts collection of contracts resolved by current contract
   * @returns location of the statement and its model and model statements
   * @memberof SolidityDefinitionProvider
   */
  async findDirectImport(
    model,
    statements,
    name,
    type,
    contracts,
  ) {
    // find in the current file
    let location = this.findStatementLocationByNameType(model, statements, name, type)

    // find in direct imports if not found in file
    const contract = contracts.contracts[0]
    // TODO: when importing contracts with conflict names, which one will Solidity pick? first or last? or error?
    for (let i = 0; location === undefined && i < contract.imports.length; i++) {
      const importedContract = await Contract.import(contract.imports[i], await contract.model)
      if (!importedContract) {
        continue
      }
      model = await importedContract.model
      let result
      try {
        result = solparse.parse(model.getValue())
      } catch (e) {
        if (!e.result) {
          continue
        }
        result = e.result
      }
      statements = result.body
      location = this.findStatementLocationByNameType(model, statements, name, type)
    }

    return {
      model,
      location,
      statements,
    }
  }

  /**
   * Find the first statement by its name and type
   *
   * @private
   * @param {monaco.editor.ITextModel} model model where statements belong, used to convert offset to position
   * @param {Array<any>} statements list of statements to search through
   * @param {string} name name of statement to find
   * @param {string} type type of statement to find
   * @returns {monaco.languages.LocationLink[]} the location of the found statement
   * @memberof SolidityDefinitionProvider
   */
  findStatementLocationByNameType(
    model,
    statements,
    name,
    type,
  ) {
    const localDef = statements.find(e => e.type === type && e.name === name)
    if (localDef !== undefined) {
      // TODO
      const range = monaco.Range.fromPositions(
        model.getPositionAt(localDef.start),
        model.getPositionAt(localDef.end)
      )
      return [{ uri: model.uri, range, targetSelectionRange: range }]
    }
  }

  /**
   * Find the first element that surrounds offset
   *
   * @private
   * @param {Array<any>} elements list of elements that has `start` and `end` member
   * @param {number} offset cursor offset
   * @returns {*} the first element where offset \in [start, end]
   * @memberof SolidityDefinitionProvider
   */
  findElementByOffset(elements, offset) {
    return elements.find(
      element => element.start <= offset && offset <= element.end,
    )
  }
}

/**
 * Resolve import statement to absolute file path
 *
 * @private
 * @param {string} importPath import statement in *.sol contract
 * @param {Contract} contract the contract where the import statement belongs
 * @returns {string} the absolute path of the imported file
 * @memberof SolidityDefinitionProvider
 */
function resolveImportPath (importPath, model) {
  const { path, projectRoot } = BaseProjectManager.instance
  if (path.isAbsolute(importPath)) {
    return importPath
  } else {
    if (importPath.startsWith('.')) {
      const { dir } = path.parse(model.uri.path)
      return path.join(dir, importPath)
    } else {
      return path.join(projectRoot, 'node_modules', importPath)
    }
  }
}