import { CompletionItemKind } from "vscode-languageserver"
import type { VDFTextDocumentSchema } from "../../VDFTextDocument"
import clientscheme from "../clientscheme.json"
import keys from "../keys.json"
import values from "../values.json"

export const VGUISchema: VDFTextDocumentSchema = {
	keys: keys,
	values: values,
	definitionReferences: [
		{
			type: Symbol.for("element"),
			definition: {
				directParentKeys: [],
				children: true,
				key: { name: "fieldName".toLowerCase(), priority: false }
			},
			reference: {
				keys: new Set([
					"pin_to_sibling",
					"navUp".toLowerCase(),
					"navDown".toLowerCase(),
					"navLeft".toLowerCase(),
					"navRight".toLowerCase(),
					"navToRelay".toLowerCase(),
				]),
				match: null
			}
		},
		{
			type: Symbol.for("color"),
			definition: null,
			reference: {
				keys: new Set(clientscheme.Colors),
				match: (string) => !/\d+\s+\d+\s+\d+\s+\d+/.test(string) // Exclude colour literals
			}
		},
		{
			type: Symbol.for("border"),
			definition: null,
			reference: {
				keys: new Set(clientscheme.Borders),
				match: null
			}
		},
		{
			type: Symbol.for("font"),
			definition: null,
			reference: {
				keys: new Set(clientscheme.Fonts),
				match: null
			}
		},
		{
			type: Symbol.for("string"),
			definition: null,
			reference: {
				keys: new Set(["labelText".toLowerCase(), "title", "tooltip"]),
				match: (string) => /^#/.test(string),
				toDefinition: (string) => string.substring("#".length)
			},
			toReference: (value) => `#${value}`,
			toCompletionItem: (definition) => ({ kind: CompletionItemKind.Text, insertText: `#${definition.key}` })
		}
	],
	files: [
		{
			name: "image",
			parentKeys: [],
			keys: new Set([
				"image",
				...Array.from({ length: 3 }, (_, index) => `teambg_${index + 1}`)
			]),
			folder: "materials/vgui",
			resolve: (name) => name.endsWith(".vmt") ? name : `${name}.vmt`,
			extensionsPattern: ".vmt",
			displayExtensions: false,
		},
		{
			name: "sound",
			parentKeys: [],
			keys: new Set([
				"sound_depressed",
				"sound_released"
			]),
			folder: "sound",
			resolve: (name) => name,
			extensionsPattern: null,
			displayExtensions: true
		}
	],
	colours: {
		keys: null,
		colours: [
			{
				pattern: /^\s*?\d+\s+\d+\s+\d+\s+\d+\s*?$/,
				parse(value) {
					const colour = value.trim().split(/\s+/)
					return {
						red: parseInt(colour[0]) / 255,
						green: parseInt(colour[1]) / 255,
						blue: parseInt(colour[2]) / 255,
						alpha: parseInt(colour[3]) / 255
					}
				},
				stringify(colour) {
					return `${colour.red * 255} ${colour.green * 255} ${colour.blue * 255} ${Math.round(colour.alpha * 255)}`
				},
			}
		]
	},
	completion: {
		root: [],
		typeKey: "ControlName".toLowerCase(),
		defaultType: "Panel".toLowerCase()
	}
}
