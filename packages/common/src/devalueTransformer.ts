import * as devalue from "devalue"
import { isObservable, Observable, shareReplay, Subject, Subscription } from "rxjs"
import { VDFPosition, VDFRange } from "vdf"
import { VDFDocumentSymbol, VDFDocumentSymbols } from "vdf-documentsymbols"
import { z } from "zod"
import { Uri } from "./Uri"

export interface Options {
	reducers: Record<string, (value: unknown) => any>
	revivers: Record<string, (value: any) => any>
	name: string
	subscriptions: { dispose(): any }[]
	onRequest(method: string, handler: (...params: any[]) => any): { dispose(): any }
	onNotification(method: string, handler: (...params: any[]) => any): { dispose(): any }
	sendRequest(server: string | null, method: string, param: any): Promise<any>
	sendNotification(server: string | null, method: string, param: any): Promise<void>
}

const common = {
	reducers: {
		Symbol: (value: unknown) => typeof value == "symbol" ? Symbol.keyFor(value) : undefined,
		Uri: (value: unknown) => value instanceof Uri ? value.toJSON() : undefined,
		VDFDocumentSymbol: (value: unknown) => value instanceof VDFDocumentSymbol ? value.toJSON() : undefined,
		VDFDocumentSymbols: (value: unknown) => value instanceof VDFDocumentSymbols ? value.toJSON() : undefined,
		VDFPosition: (value: unknown) => value instanceof VDFPosition ? value.toJSON() : undefined,
		VDFRange: (value: unknown) => value instanceof VDFRange ? value.toJSON() : undefined,
	},
	revivers: {
		Symbol: (value: ReturnType<Symbol["toString"]>) => Symbol.for(value),
		Uri: (value: ReturnType<Uri["toJSON"]>) => Uri.schema.parse(value),
		VDFDocumentSymbol: (value: ReturnType<VDFDocumentSymbol["toJSON"]>) => VDFDocumentSymbol.schema.parse(value),
		VDFDocumentSymbols: (value: ReturnType<VDFDocumentSymbols["toJSON"]>) => VDFDocumentSymbols.schema.parse(value),
		VDFPosition: (value: ReturnType<VDFPosition["toJSON"]>) => VDFPosition.schema.parse(value),
		VDFRange: (value: ReturnType<VDFRange["toJSON"]>) => VDFRange.schema.parse(value),
	}
}

const paramsSchema = z.object({
	server: z.string(),
	id: z.string(),
})

const nextSchema = z.object({
	id: z.string(),
	value: z.string()
})

const observableIDs = new Map<Observable<any>, string>()
const observables = new Map<string, Observable<any>>()
const serversSubscriptions = new Map<string, Map<string, Subscription>>()

const subjects = new Map<string, { subject: WeakRef<Subject<any>>, observable: WeakRef<Observable<any>> }>()

export function devalueTransformer({ reducers, revivers, name, subscriptions, onRequest, onNotification, sendRequest, sendNotification }: Options) {

	subscriptions.push(
		onRequest("vscode-vdf/observable/subscribe", (param) => {
			const { server, id } = paramsSchema.parse(param)

			let serverSubscriptions = serversSubscriptions.get(server)
			if (!serverSubscriptions) {
				serverSubscriptions = new Map()
				serversSubscriptions.set(server, serverSubscriptions)
			}

			const observable = observables.get(id)
			if (!observable) {
				throw new Error(`No observable "${id}" for subscribe`)
			}

			let subscription = serverSubscriptions.get(id)
			if (!subscription) {
				subscription = observable.subscribe((value) => {
					sendNotification(server, "vscode-vdf/observable/next", { id: id, value: devalue.stringify(value, inputReducers) })
				})

				serverSubscriptions.set(id, subscription)
			}
		}),
		onRequest("vscode-vdf/observable/unsubscribe", (param) => {
			const { server, id } = paramsSchema.parse(param)

			let serverSubscriptions = serversSubscriptions.get(server)
			if (!serverSubscriptions) {
				serverSubscriptions = new Map()
				serversSubscriptions.set(server, serverSubscriptions)
			}

			serverSubscriptions.get(id)?.unsubscribe()
			serverSubscriptions.delete(id)

			if (serverSubscriptions.size == 0) {
				serversSubscriptions.delete(server)
			}
		}),
		onNotification("vscode-vdf/observable/next", (param: unknown) => {
			const { id, value } = nextSchema.parse(param)

			const subject = subjects.get(id)?.subject.deref()
			if (!subject) {
				subjects.delete(id)
				throw new Error(`No subject "${id}" for next`)
			}

			subject.next(devalue.parse(value, inputRevivers))
		})
	)

	const inputReducers = {
		...common.reducers,
		...reducers
	}

	const inputRevivers = {
		...common.revivers,
		...revivers
	}

	const outputReducers = {
		...common.reducers,
		...reducers,
		Observable: (value: unknown) => {
			if (isObservable(value)) {

				let id = observableIDs.get(value)
				if (!id) {
					id = crypto.randomUUID()
					observableIDs.set(value, id)
					observables.set(id, value)
				}

				return { server: name, id: id }
			}
		}
	}

	const outputRevivers = {
		...common.revivers,
		...revivers,
		Observable: (value: { server: string, id: string }) => {
			let subject = subjects.get(value.id)
			if (!subject) {
				const s = new Subject()
				const params = { server: name, id: value.id }

				const o = new Observable((subscriber) => {
					const subscription = s.subscribe(subscriber)
					sendRequest(value.server, "vscode-vdf/observable/subscribe", params)
					return {
						unsubscribe: () => {
							subscription.unsubscribe()
							sendRequest(value.server, "vscode-vdf/observable/unsubscribe", params)
						}
					}
				}).pipe(
					shareReplay({
						bufferSize: 1,
						refCount: true
					})
				)

				const registry = new FinalizationRegistry<string>((heldValue) => {
					subjects.delete(heldValue)
					sendRequest(value.server, "vscode-vdf/observable/free", params)
				})

				registry.register(s, value.id)

				subject = { subject: new WeakRef(s), observable: new WeakRef(o) }
				subjects.set(value.id, subject)
			}

			return subject.observable.deref()!
		}
	}

	return {
		input: {
			serialize: (object: any) => devalue.stringify(object, inputReducers),
			deserialize: (object: any) => devalue.parse(object, inputRevivers)
		},
		output: {
			serialize: (object: any) => devalue.stringify(object, outputReducers),
			deserialize: (object: any) => devalue.parse(object, outputRevivers)
		}
	}
}
