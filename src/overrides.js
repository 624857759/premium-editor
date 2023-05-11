import { ImmortalReference } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
import { isCodeEditor } from 'monaco-editor/esm/vs/editor/browser/editorBrowser.js'
import { SimpleModel, SimpleEditorModelResolverService } from 'monaco-editor/esm/vs/editor/standalone/browser/simpleServices'
import { StaticServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices'

import { modelSessionManager } from '@obsidians/code-editor'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function withTypedEditor(widget, codeEditorCallback, diffEditorCallback) {
  return isCodeEditor(widget) ? codeEditorCallback(widget) : diffEditorCallback(widget)
}
SimpleEditorModelResolverService.prototype.createModelReference = async function (resource) {
  let model = null
  if (this.editor) {
    model = await withTypedEditor(
      this.editor,
      editor => this.findModel(editor, resource) ,
      diffEditor => this.findModel(diffEditor.getOriginalEditor(), resource) || this.findModel(diffEditor.getModifiedEditor(), resource)
    )
  }
  if (!model) {
    throw new Error('Model not found')
  }
  return new ImmortalReference(new SimpleModel(model))
}
SimpleEditorModelResolverService.prototype.findModel = async function (editor, resource) {
  let model = this.modelService && this.modelService.getModel(resource)
  if (!model) {
    const modelSession = await modelSessionManager.newModelSession(resource.path)
    model = modelSession.model
  }
  if (model && model.uri.toString() !== resource.toString()) {
    return null
  }
  return model
}

const codeEditorService = StaticServices.codeEditorService.get()
const openCodeEditor = codeEditorService.openCodeEditor
codeEditorService.openCodeEditor = async function (option, editor, sideBySide) {
  if (modelSessionManager.currentModelSession?.model.uri.toString() === option.resource.toString()) {
    return openCodeEditor.apply(this, [option, editor, sideBySide])
  }
  const filePath = option.resource.path
  if (filePath && await modelSessionManager.projectManager.isFile(filePath)) {
    modelSessionManager.openFile(filePath)
  }

  await delay(300)

  const selection = option.options?.selection
  if (selection) {
    editor.setSelection(selection)
    editor.revealRangeInCenter(selection, 1)
  }
  return editor
}

export default codeEditorService
