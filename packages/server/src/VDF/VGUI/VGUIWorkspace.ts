import { usingAsync } from "common/operators/usingAsync"
import { Uri } from "common/Uri"
import { posix } from "path"
import { BehaviorSubject, combineLatest, concatMap, defer, distinctUntilChanged, firstValueFrom, map, of, pairwise, shareReplay, startWith, Subscription, switchMap, type Observable } from "rxjs"
import type { VDFDocumentSymbols } from "vdf-documentsymbols"
import { Collection, DefinitionReferences, Definitions, References, type Definition } from "../../DefinitionReferences"
import type { TeamFortress2FileSystem } from "../../TeamFortress2FileSystem"
import type { TextDocuments } from "../../TextDocuments"
import { WorkspaceBase } from "../../WorkspaceBase"
import { VGUITextDocument } from "./VGUITextDocument"

export const enum VGUIFileType {
	None = 0,
	ClientScheme = 1,
	SourceScheme = 2,
	LanguageTokens = 3,
	HUDAnimationsManifest = 4,
}

export class VGUIWorkspace extends WorkspaceBase {

	private static readonly files = {
		clientSchemeFiles: new Set(["resource/clientscheme.res"]),
		sourceSchemeFiles: new Set(["resource/sourcescheme.res", "resource/SourceSchemeBase.res"]),
		languageTokensFiles: new Set(["resource/chat_english.txt", "resource/tf_english.txt"])
	}

	public static fileType(uri: Uri, teamFortress2Folder$: Observable<Uri>) {
		return defer(() => {
			switch (uri.scheme) {
				case "file":
					return teamFortress2Folder$.pipe(
						map((teamFortress2Folder) => posix.relative(teamFortress2Folder.joinPath("tf").path, uri.path))
					)
				case "vpk":
				case "vscode-vdf-tf-remote-resource":
					return of(uri.path.substring(1))
				default:
					// https://github.com/microsoft/vscode/blob/main/src/vs/base/common/network.ts
					console.warn(`Unknown Uri.scheme: ${uri}`)
					return of(null)
			}
		}).pipe(
			map((path) => {
				const { clientSchemeFiles, sourceSchemeFiles, languageTokensFiles } = VGUIWorkspace.files
				if (path != null) {
					if (clientSchemeFiles.has(path)) {
						return VGUIFileType.ClientScheme
					}
					else if (sourceSchemeFiles.has(path)) {
						return VGUIFileType.SourceScheme
					}
					else if (languageTokensFiles.has(path)) {
						return VGUIFileType.LanguageTokens
					}
					else {
						return VGUIFileType.None
					}
				}
				else {
					return VGUIFileType.None
				}
			}),
			distinctUntilChanged()
		)
	}

	private readonly subscriptions: Subscription[]
	private readonly fileSystem$: Observable<TeamFortress2FileSystem>
	private readonly documents: TextDocuments<VGUITextDocument>

	public readonly clientSchemeFiles$: Observable<Set<string>>
	public readonly clientScheme$: Observable<DefinitionReferences>

	public readonly sourceSchemeFiles$: Observable<Set<string>>

	public readonly languageTokensFiles$: Observable<Set<string>>
	public readonly languageTokens$: Observable<DefinitionReferences>

	public readonly workspaceReferencesReady: Promise<void>

	private readonly documentSymbols: Map<string, Observable<VDFDocumentSymbols | null>>
	public readonly fileReferences: Map<string, { references$: BehaviorSubject<Map<string, References | null>>, document$: Observable<VGUITextDocument | null> }>

	constructor({
		uri,
		fileSystem$,
		documents,
		request
	}: {
		uri: Uri,
		fileSystem$: Observable<TeamFortress2FileSystem>,
		documents: TextDocuments<VGUITextDocument>,
		request: Promise<void>,
	}) {
		super(uri)
		this.subscriptions = []
		this.fileSystem$ = fileSystem$
		this.documents = documents

		const files = (path: string): Observable<string[]> => {
			return fileSystem$.pipe(
				switchMap((fileSystem) => fileSystem.resolveFile(path)),
				switchMap((uri) => {
					return uri != null
						? usingAsync(() => documents.get(uri, true))
						: of(null)
				}),
				switchMap((document) => {
					if (!document) {
						return of([path])
					}

					return document.documentSymbols$.pipe(
						map((documentSymbols) => {
							return documentSymbols
								.filter((documentSymbol) => documentSymbol.key == "#base" && documentSymbol.detail)
								.map((documentSymbol) => posix.resolve(`/${posix.dirname(path)}/${documentSymbol.detail}`).substring(1))
						}),
						distinctUntilChanged((previous, current) => {
							return previous.length == current.length && previous.every((path, index) => path == current[index])
						}),
						switchMap((paths) => {
							return paths.length
								? combineLatest(paths.map((path) => files(path))).pipe(map((paths) => paths.flat()))
								: new BehaviorSubject([])
						}),
						map((paths) => [path, ...paths]),
					)
				})
			)
		}

		const definitions = (path: string): Observable<DefinitionReferences> => {
			return fileSystem$.pipe(
				switchMap((fileSystem) => fileSystem.resolveFile(path)),
				concatMap(async (uri) => {
					if (!uri) {
						throw new Error(path)
					}

					return await documents.get(uri, true)
				}),
				switchMap((document) => {
					return document.definitionReferences$
				}),
				shareReplay(1)
			)
		}

		this.clientSchemeFiles$ = files("resource/clientscheme.res").pipe(map((paths) => new Set(paths)), shareReplay(1))
		this.clientScheme$ = definitions("resource/clientscheme.res")

		// Preload clientscheme
		firstValueFrom(this.clientScheme$)

		// Preload hudanimations_manifest
		firstValueFrom(
			fileSystem$.pipe(
				switchMap((fileSystem) => {
					return fileSystem.resolveFile("scripts/hudanimations_manifest.txt").pipe(
						map((uri) => {
							if (uri) {
								documents.get(uri, true)
							}
						})
					)
				})
			)
		)

		this.sourceSchemeFiles$ = files("resource/sourcescheme.res").pipe(map((paths) => new Set(paths)), shareReplay(1))

		this.languageTokensFiles$ = combineLatest([files("resource/chat_english.txt"), files("resource/tf_english.txt")]).pipe(
			map((paths) => new Set(paths.flat())),
			shareReplay(1)
		)

		this.languageTokens$ = combineLatest([
			definitions("resource/chat_english.txt"),
			definitions("resource/tf_english.txt")
		]).pipe(
			map((dependencies) => {
				const definitions = new Collection<Definition>()

				for (const definitionReferences of dependencies) {
					for (const definition of definitionReferences.definitions) {
						definitions.set(definition.type, definition.key, ...definition.value)
					}
				}

				return new DefinitionReferences(
					new Definitions({
						collection: definitions,
						globals: [],
					}),
					new References(this.uri, undefined, dependencies.map(({ references }) => references))
				)
			}),
			shareReplay(1)
		)

		this.documentSymbols = new Map()
		this.fileReferences = new Map()

		const { promise, resolve } = Promise.withResolvers<void>()
		this.workspaceReferencesReady = promise

		firstValueFrom(fileSystem$).then(async (fileSystem) => {
			const [clientSchemeFiles, sourceSchemeFiles, languageTokenFiles] = await Promise.all([
				firstValueFrom(this.clientSchemeFiles$),
				firstValueFrom(this.sourceSchemeFiles$),
				firstValueFrom(this.languageTokensFiles$),
			])

			const entries = await fileSystem.readDirectory("resource/ui", { recursive: true, pattern: "**/*.res" })

			const promises: Promise<void>[] = []

			for (const [name, type] of entries) {
				if (type == 2 || clientSchemeFiles.has(name) || sourceSchemeFiles.has(name) || languageTokenFiles.has(name)) {
					continue
				}

				const { promise, resolve } = Promise.withResolvers<void>()
				promises.push(promise)

				setTimeout(async () => {
					const path = posix.join("resource/ui", name)
					const uri = await firstValueFrom(fileSystem.resolveFile(path))
					if (uri) {
						using document = await documents.get(uri, true)
						await firstValueFrom(document.definitionReferences$)
					}
					resolve()
				}, 0)
			}

			await Promise.allSettled(promises)
			resolve()
		})
	}

	public fileType(uri: Uri) {
		const path = this.relative(uri)
		return combineLatest({
			clientSchemeFiles: this.clientSchemeFiles$,
			sourceSchemeFiles: this.sourceSchemeFiles$,
			languageTokensFiles: this.languageTokensFiles$
		}).pipe(
			map(({ clientSchemeFiles, sourceSchemeFiles, languageTokensFiles }) => {
				if (clientSchemeFiles.has(path)) {
					return VGUIFileType.ClientScheme
				}
				else if (sourceSchemeFiles.has(path)) {
					return VGUIFileType.SourceScheme
				}
				else if (languageTokensFiles.has(path)) {
					return VGUIFileType.LanguageTokens
				}
				else if (path == "scripts/hudanimations_manifest.txt") {
					return VGUIFileType.HUDAnimationsManifest
				}
				return VGUIFileType.None
			}),
			distinctUntilChanged(),
			shareReplay(1)
		)
	}

	public getVDFDocumentSymbols(path: string): Observable<VDFDocumentSymbols | null> {
		let documentSymbols$ = this.documentSymbols.get(path)
		if (!documentSymbols$) {
			documentSymbols$ = this.fileSystem$.pipe(
				switchMap((fileSystem) => fileSystem.resolveFile(path)),
				concatMap(async (uri) => {
					return uri
						? this.documents.get(uri, true)
						: null
				}),
				switchMap((document) => {
					return document != null
						? document.documentSymbols$
						: of(null)
				}),
				shareReplay(1)
			)
			this.documentSymbols.set(path, documentSymbols$)
		}
		return documentSymbols$
	}

	public getDefinitionReferences(path: string) {
		return this.fileSystem$.pipe(
			switchMap((fileSystem) => fileSystem.resolveFile(path)),
			switchMap((uri) => uri != null ? usingAsync(() => this.documents.get(uri, true)) : of(null)),
			switchMap((document) => document != null ? document.definitionReferences$ : of(null)),
			shareReplay(1)
		)
	}

	public async setFileReferences(path: string, references: Map<string, References | null>) {
		let fileReferences = this.fileReferences.get(path)
		if (!fileReferences) {
			fileReferences = {
				references$: new BehaviorSubject(new Map()),
				document$: this.fileSystem$.pipe(
					switchMap((fileSystem) => fileSystem.resolveFile(path)),
					switchMap((uri) => uri != null ? usingAsync(() => this.documents.get(uri, true)) : of(null)),
					startWith(null),
					pairwise(),
					map(([previous, current]) => {
						if (previous) {
							previous.setDocumentReferences(new Map(references.keys().map((uri) => [uri, null])))
						}

						if (current) {
							current.setDocumentReferences(references)
						}

						return current
					})
				)
			}
			this.fileReferences.set(path, fileReferences)

			combineLatest({
				references: fileReferences.references$,
				document: fileReferences.document$,
			}).subscribe(({ references, document }) => {
				if (document) {
					document.setDocumentReferences(references)
				}
			})
		}

		for (const [uri, documentReferences] of references) {
			fileReferences.references$.value.set(uri, documentReferences)
		}

		fileReferences.references$.next(fileReferences.references$.value)
	}

	public dispose() {
		for (const subscription of this.subscriptions) {
			subscription.unsubscribe()
		}
	}
}
