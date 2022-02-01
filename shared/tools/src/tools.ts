import { execSync } from "child_process"
import fs, { existsSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import path, { dirname, join } from "path"
import { fileURLToPath, pathToFileURL, URL } from "url"
import { TextDocument } from "vscode-languageserver-textdocument"
import { CompletionItem, CompletionItemKind, Definition, DocumentSymbol, Position, Range, SymbolKind } from "vscode-languageserver/node"
import { VDF } from "../../VDF"
import { VDFTokeniserOptions } from "../../VDF/dist/models/VDFTokeniserOptions"
import { UnexpectedTokenError } from "../../VDF/dist/VDFErrors"
import { VDFTokeniser } from "../../VDF/dist/VDFTokeniser"

export interface VSCodeVDFSettings {
	readonly autoCompletionKind: "incremental" | "all"
	readonly hudAnimations: {
		readonly layoutScope: "event" | "file"
		readonly extraTabs: number
		readonly referencesCodeLens: {
			readonly showOnAllEvents: boolean
		}
	}
	readonly referencesCodeLens: {
		readonly showOnAllElements: boolean
	}
	readonly teamFortess2Folder: string
}

/**
 * Recursive merge all properties from one object into another
 * @param obj1 First Object
 * @param obj2 Second Object
 */
export function merge(obj1: any, obj2: any): any {
	for (let i in obj1) {
		if (typeof obj1[i] === "object") {
			if (obj2.hasOwnProperty(i) && typeof obj2[i] == "object") {
				merge(obj1[i], obj2[i])
			}
		}
		else {
			if (obj2.hasOwnProperty(i)) {
				obj1[i] = obj2[i]
			}
		}
	}
	for (let j in obj2) {
		// check if property exists because we dont want to shallow merge an object
		if (!obj1.hasOwnProperty(j)) {
			obj1[j] = obj2[j]
		}
	}
	return obj1
}

/**
 * Resolve root folder of an absolute HUD file path
 * @param uri File uri containing object.
 * @returns The root of the HUD folder as a file path string (`C:/...`)
 */
export function getHUDRoot({ uri }: { uri: string }): string | null {
	let folderPath = fileURLToPath(uri)
	while (folderPath != `${new URL(folderPath).protocol}\\`) {
		if (fs.existsSync(`${folderPath}/info.vdf`)) {
			return folderPath
		}
		folderPath = path.dirname(folderPath)
	}
	return null
}

/**
 * Load all key/values from a .res file (include #base files)
 * @description This function will load all controls in .res files and does not match the behaviour of TF2 .res loading
 * @param filePath .res path
 */
export function loadAllControls(filePath: string): any {
	const origin: object = {}

	const filterString = (value: unknown): value is string => typeof value == "string"

	const addControls = (filePath: string) => {
		const obj = fs.existsSync(filePath) ? VDF.parse(fs.readFileSync(filePath, "utf-8")) : {}
		if (obj.hasOwnProperty("#base")) {
			const baseFiles: string[] = Array.isArray(obj["#base"]) ? obj["#base"].filter(filterString) : [...Object.values(obj["#base"]).filter(filterString)]
			const folder = path.dirname(filePath)
			for (const baseFile of baseFiles) {
				addControls(`${folder}/${baseFile}`)
			}
		}
		merge(origin, obj)
	}
	addControls(filePath)
	return origin
}
export interface VDFDocumentSymbol extends DocumentSymbol {

	/**
	 * User visible document symbol name e.g. xpos
	 */
	readonly name: string


	/**
	 * Documentsymbol VDF key e.g. xpos^[$WIN32]
	 */
	readonly key: string

	/**
	 * Document range containing key
	 */
	readonly nameRange: Range

	/**
	 * VDF Document Symbol OS Tag e.g. [$WIN32]
	 */
	readonly osTag?: string

	/**
	 * VDF Document Symbol Primitive Value
	 */
	readonly detail?: string

	/**
	 * VDF Document Symbol Primitive Value Range
	 */
	readonly detailRange?: Range

	/**
	 * VDF Document Symbol children
	 */
	readonly children?: VDFDocumentSymbol[]
}

export function getVDFDocumentSymbols(str: string, options?: VDFTokeniserOptions): VDFDocumentSymbol[] {
	const tokeniser = new VDFTokeniser(str, options)
	const trim = (str: string): [string, 0 | 1] => {
		const quoted = str.startsWith("\"") && str.endsWith("\"")
		return quoted ? [str.slice(1, -1), 1] : [str, 0];
	}
	const isOSTag = (str: string): str is `[${string}]` => {
		return str.startsWith("[") && str.endsWith("]")
	}
	/**
	 * Gets a list of key/value pairs between an opening and closing brace
	 * @param obj Whether the object to be parsed is NOT a top level object
	 */
	const parseObject = (obj: boolean): VDFDocumentSymbol[] => {
		const documentSymbols: VDFDocumentSymbol[] = []

		let currentToken = tokeniser.next()
		let nextToken = tokeniser.next(true)

		const objectTerminator = obj ? "}" : "__EOF__"
		while (currentToken != objectTerminator) {
			const [key, keyQuoted] = trim(currentToken)
			const startPosition = Position.create(tokeniser.line, tokeniser.character - key.length - keyQuoted)
			const nameRange: Range = Range.create(startPosition, Position.create(tokeniser.line, tokeniser.character - keyQuoted))

			if (VDFTokeniser.whiteSpaceTokenTerminate.includes(currentToken)) {
				throw new UnexpectedTokenError(currentToken, "key", nameRange)
			}

			nextToken = tokeniser.next()

			let osTag: string | undefined
			let children: VDFDocumentSymbol[] | undefined
			let detail: string | undefined
			let detailQuoted: 0 | 1
			let detailRange: Range | undefined

			if (nextToken == "{") {
				children = parseObject(true)
			}
			else if (isOSTag(nextToken)) {
				osTag = nextToken
				const value = tokeniser.next()
				if (value == "{") {
					// Object
					children = parseObject(true)
				}
				else {
					// Primitive
					[detail, detailQuoted] = trim(value)
					detailRange = Range.create(Position.create(tokeniser.line, tokeniser.character - detail.length - detailQuoted), Position.create(tokeniser.line, tokeniser.character - detailQuoted))

					if (value == "__EOF__" || VDFTokeniser.whiteSpaceTokenTerminate.includes(detail)) {
						throw new UnexpectedTokenError(value, "value", detailRange)
					}

					let osTag2 = tokeniser.next(true)
					if (isOSTag(osTag2)) {
						osTag = osTag2
						tokeniser.next() // Skip OS Tag
					}
				}
			}
			else {
				[detail, detailQuoted] = trim(nextToken)
				detailRange = Range.create(Position.create(tokeniser.line, tokeniser.character - detail.length - detailQuoted), Position.create(tokeniser.line, tokeniser.character - detailQuoted))
				if (nextToken == "__EOF__" || VDFTokeniser.whiteSpaceTokenTerminate.includes(nextToken)) {
					throw new UnexpectedTokenError(detail, "value", detailRange)
				}

				// OS Tag
				nextToken = tokeniser.next(true)
				if (isOSTag(nextToken)) {
					osTag = nextToken
					tokeniser.next()
				}
			}

			const endPosition = Position.create(tokeniser.line, tokeniser.character)
			const selectionRange = Range.create(startPosition, endPosition)

			documentSymbols.push({
				name: `${key}${osTag != undefined ? ` ${osTag}` : ""}`,
				key: key,
				nameRange: nameRange,
				kind: children != undefined ? SymbolKind.Object : SymbolKind.String,
				range: selectionRange,
				selectionRange: selectionRange,
				...(osTag != undefined && {
					osTag: osTag
				}),
				...(children != undefined && {
					children: children
				}),
				...(detail != undefined && {
					detail: detail
				}),
				...(detailRange != undefined && {
					detailRange: detailRange
				})
			})

			currentToken = tokeniser.next()
			nextToken = tokeniser.next(true)
		}

		return documentSymbols

	}
	return parseObject(false)
}

/**
* Search a HUD file for a specified key/value pair
* @param uri Uri path to file
* @param str fileContents or file DocumentSymbol[]
* @param key key name to search for.
* @param value value to search for (Optional)
* @param parentKeyConstraint
* @returns The file uri (starting with file:///), line and character of the specified key (or null if the key is not found)
*/
export function getLocationOfKey(uri: string, str: string | VDFDocumentSymbol[], key: string, value?: string, parentKeyConstraint?: string): Definition | null {
	const searchFile = (filePath: string, documentSymbols: VDFDocumentSymbol[]) => {
		const objectPath: string[] = []
		const search = (documentSymbols: VDFDocumentSymbol[]): Definition | null => {
			for (const documentSymbol of documentSymbols) {
				objectPath.push(documentSymbol.name.toLowerCase())
				const currentKey: string = documentSymbol.name.toLowerCase()
				if (currentKey == "#base") {
					const baseFilePath = `${path.dirname(filePath)}/${documentSymbol.detail}`
					if (fs.existsSync(baseFilePath)) {
						const result = searchFile(baseFilePath, getVDFDocumentSymbols(fs.readFileSync(baseFilePath, "utf-8")))
						if (result) {
							return result
						}
					}
				}
				if (currentKey == key && (value ? documentSymbol.detail == value : true) && (parentKeyConstraint ? objectPath.includes(parentKeyConstraint.toLowerCase()) : true)) {
					return {
						uri: pathToFileURL(filePath).href,
						range: documentSymbol.nameRange
					}
				}
				if (documentSymbol.children) {
					const result = search(documentSymbol.children)
					if (result) {
						return result
					}
				}
				objectPath.pop()
			}
			return null
		}
		return search(documentSymbols)
	}

	uri = uri.startsWith("file:///") ? fileURLToPath(uri) : uri
	str = typeof str == "string" ? getVDFDocumentSymbols(str) : str
	key = key.toLowerCase()

	return searchFile(uri, str)
}

/**
 *
 * @param str Document contents or VDF Document Symbols (VDFDocumentSymbol[])
 * @param position Position to document symbol at
 * @returns
 */
export function getDocumentSymbolsAtPosition(str: string | VDFDocumentSymbol[], position: Position): VDFDocumentSymbol[] | null {
	const elementStack: VDFDocumentSymbol[] = []
	const search = (documentSymbols: VDFDocumentSymbol[]): VDFDocumentSymbol[] | null => {
		for (const documentSymbol of documentSymbols) {
			elementStack.push(documentSymbol)
			if (documentSymbol.children) {
				const result = search(documentSymbol.children)
				if (result != null) {
					return result
				}
			}
			if (RangecontainsPosition(documentSymbol.range, position)) {
				return elementStack.reverse()
			}
			elementStack.pop()
		}
		return null
	}
	str = typeof str == "string" ? getVDFDocumentSymbols(str) : str
	return search(str)
}


const sectionIcons = {
	"Colors": CompletionItemKind.Color,
	"Borders": CompletionItemKind.Snippet,
	"Fonts": CompletionItemKind.Text,
}

export function clientschemeValues(document: TextDocument, section: "Colors" | "Borders" | "Fonts"): CompletionItem[] {
	const hudRoot = getHUDRoot(document)
	if (hudRoot == null) {
		return []
	}

	const clientschemePath = `${hudRoot}/resource/clientscheme.res`
	let hudclientscheme: any

	if (existsSync(clientschemePath)) {
		hudclientscheme = loadAllControls(clientschemePath)
		return Object.entries(hudclientscheme["Scheme"][section]).map(([key, value]: [string, any]) => {
			switch (section) {
				case "Colors": {
					let colourValue: string = value
					while (/[^\s\d]/.test(colourValue) && colourValue != undefined) {
						colourValue = <string>hudclientscheme["Scheme"]["Colors"][colourValue]
					}

					let colours: number[] = colourValue.split(/\s+/).map(parseFloat)

					const r = colours[0].toString(16)
					const g = colours[1].toString(16)
					const b = colours[2].toString(16)
					const a = (colours[3] * 255).toString(16)

					const hex = `#${r.length == 1 ? `0${r}` : r}${g.length == 1 ? `0${g}` : g}${b.length == 1 ? `0${b}` : b}`
					return {
						label: key,
						kind: sectionIcons[section],
						documentation: hex
					}
				}
				case "Borders": {
					return {
						label: key,
						kind: sectionIcons[section],
						detail: value?.bordertype == "scalable_image"
							? `[Image] ${value?.image ?? ""}${value?.image && value?.color ? " " : ""}${value?.color ?? ""} `
							: ((): string => {
								const firstBorderSideKey = Object.keys(value).find(i => typeof value[i] == "object")
								if (firstBorderSideKey) {
									const firstBorderSide = value[firstBorderSideKey]
									const thickness = Object.keys(firstBorderSide).length
									const colour: string = firstBorderSide[Object.keys(firstBorderSide)[0]].color
									return `[Line] ${thickness}px ${/\s/.test(colour) ? `"${colour}"` : colour} `
								}
								return ""
							})()
					}
				}
				case "Fonts": {
					return {
						label: key,
						kind: sectionIcons[section],
						detail: `${value["1"]?.name ?? ""}${value?.["1"]?.name && value?.["1"]?.tall ? " " : ""}${value["1"]?.tall ?? ""}`
					}
				}
			}
		})
	}

	return []
}

export function getCodeLensTitle(references: number): string {
	return `${references} reference${references == 1 ? "" : "s"}`
}

export function RangecontainsPosition(range: Range, position: Position): boolean {
	if (range.start.line > position.line || range.end.line < position.line) {
		return false
	}
	// Disabled because documents.onDidChangeContent takes a while to catch up so connection.onCompletion uses old layout when you enter newlines
	// if (range.start.line == position.line && position.character < range.start.character) {
	// 	return false
	// }
	// if (range.end.line == position.line && position.character > range.end.character) {
	// 	return false
	// }
	return true
}

export function RangecontainsRange(range: Range, { start, end }: Range): boolean {
	return RangecontainsPosition(range, start) && RangecontainsPosition(range, end)
}

export function getLineRange(line: number): Range {
	return {
		start: {
			line: line,
			character: 0
		},
		end: {
			line: line,
			character: Infinity
		}
	}
}

export function recursiveDocumentSymbolLookup(documentSymbols: VDFDocumentSymbol[], callback: (documentSymbol: VDFDocumentSymbol) => boolean): VDFDocumentSymbol | null {
	const search = (_documentSymbols: VDFDocumentSymbol[]): ReturnType<typeof recursiveDocumentSymbolLookup> => {
		for (const documentSymbol of _documentSymbols) {
			if (documentSymbol.children) {
				const result = search(documentSymbol.children)
				if (result != null) {
					return result
				}
			}
			if (callback(documentSymbol)) {
				return documentSymbol
			}
		}
		return null
	}
	return search(documentSymbols)
}


export function VPKExtract(teamFortress2Folder: string, vpkPath: string, file: string): string | null {
	const vpkBinPath = join(teamFortress2Folder, "bin", existsSync(join(teamFortress2Folder, "bin/vpk.exe")) ? "vpk" : "vpk_linux32")
	const temp = tmpdir()
	mkdirSync(join(temp, dirname(file)), { recursive: true })
	const outputPath = join(temp, file)
	const args: string[] = [
		`"${vpkBinPath}"`,
		`x`,
		`"${join(teamFortress2Folder, vpkPath)}"`,
		`"${file}"`
	]
	execSync(args.join(" "), { cwd: temp })
	return existsSync(outputPath) ? outputPath : null
}
