/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	SymbolInformation,
	DocumentSymbolParams,
	SymbolKind,
	SignatureHelpParams,
	SignatureHelp,
	SignatureInformation,
	ParameterInformation,
	CancellationToken,
	DefinitionParams,
	Definition,
	CompletionParams
} from 'vscode-languageserver';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';
import {
	buildKeyWordCompletions,
	buildbuiltin_variable,
	// serverName,
	languageServer
} from './utilities/constants'

import { builtin_variable } from "./utilities/builtins";
import { Lexer } from './parser/regParser/ahkparser'
import { TreeManager } from './services/treeManager';
import { ISymbolNode } from './parser/regParser/types';
import { Logger } from './utilities/logger';


// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. 
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;
const logger = new Logger(connection.console);
let keyWordCompletions: CompletionItem[] = buildKeyWordCompletions();
let builtinVariableCompletions: CompletionItem[] = buildbuiltin_variable();
let DOCManager: TreeManager = new TreeManager(connection, logger);

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		serverInfo: {
			// The name of the server as defined by the server.
			name: languageServer,
	
			// The servers's version as defined by the server.
			// version: this.version,
		},
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			// `/` and `<` is only used for include compeltion
			completionProvider: {
				resolveProvider: true,
				triggerCharacters: ['.', '/', '<']
			},
			signatureHelpProvider: {
				triggerCharacters: ['(', ',']
			},
			documentSymbolProvider: true,
			definitionProvider: true
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

/**
 * Name of AHK document language 
 */
enum docLangName {
	CN = 'CN',
	NO = 'no'		// No Doc
};

// The AHK Language Server settings
interface AHKLSSettings {
	maxNumberOfProblems: number;
	documentLanguage: docLangName;			// which language doc to be used
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: AHKLSSettings = { 
	maxNumberOfProblems: 1000,
	documentLanguage: docLangName.NO
};
let globalSettings: AHKLSSettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<AHKLSSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <AHKLSSettings>(
			(change.settings.languageServerExample || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<AHKLSSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'AutohotkeyLanguageServer'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

function flatTree(tree: ISymbolNode[]): ISymbolNode[] {
	let result: ISymbolNode[] = [];
	tree.map(info => {
		 // FIXME: temporary soluation, invaild -1 line marked builtin property
		if (info.range.start.line !== -1) 
			result.push(info);
		if (info.subnode)
			result.push(...flatTree(info.subnode));
	});
	return result;
}

connection.onDocumentSymbol(
	(params: DocumentSymbolParams): SymbolInformation[] => {
	// 	const tree = DOCManager.selectDocument(params.textDocument.uri).getTree();

	// return flatTree(tree).map(info => {
	// 	return SymbolInformation.create(
	// 		info.name,
	// 		info.kind,
	// 		info.range,
	// 		params.textDocument.uri
	// 	);
	// });
	DOCManager.selectDocument(params.textDocument.uri);
	return DOCManager.docSymbolInfo();
});

connection.onSignatureHelp(
	async (positionParams: SignatureHelpParams, cancellation: CancellationToken): Promise<Maybe<SignatureHelp>> => {
	const { position } = positionParams;
	const { uri } = positionParams.textDocument;

	if (cancellation.isCancellationRequested) {
		return undefined;
	}

	return DOCManager.selectDocument(uri).getFuncAtPosition(position);
})

connection.onDefinition(
	async (params: DefinitionParams, token: CancellationToken): Promise<Maybe<Definition>> =>{
	if (token.isCancellationRequested) {
		return undefined;
	}

	let { position } = params;

	// search definiton at request position
	let locations = DOCManager.selectDocument(params.textDocument.uri).getDefinitionAtPosition(position);
	if (locations.length) {
		return locations
	}
	return undefined;
})

// load opened document
documents.onDidOpen(async e => {
	// let lexer = new Lexer(e.document, logger);
	// const docInfo = lexer.Parse();
	DOCManager.initDocument(e.document.uri, e.document);
});

// Only keep settings for open documents
documents.onDidClose(e => {
	// delete document infomation that is closed
	documentSettings.delete(e.document.uri);
	//TODO: better sulotion about close document
	DOCManager.deleteUnusedDocument(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	DOCManager.updateDocumentAST(change.document.uri, change.document);
	validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	// In this simple example we get the settings for every validate run.
	// let result = await getDocumentSettings(textDocument.uri);
	// connection.console.log(result.documentLanguage);
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
	async (_compeltionParams: CompletionParams, token: CancellationToken): Promise<Maybe<CompletionItem[]>> => {
		if (token.isCancellationRequested) {
			return undefined;
		}
		const {position, textDocument} = _compeltionParams;
		DOCManager.selectDocument(textDocument.uri);
		// findout if we are in an include compeltion
		if (_compeltionParams.context && 
			(_compeltionParams.context.triggerCharacter === '/' || _compeltionParams.context.triggerCharacter === '<')) {
			let result = DOCManager.includeDirCompletion(position);
			// if request is fired by `/` and `<`,but not start with "include", we exit
			if (result) 
				return result;
			else
				return undefined;
		}

		return DOCManager.getScopedCompletion(_compeltionParams.position, keyWordCompletions, builtinVariableCompletions);
	}
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	async (item: CompletionItem): Promise<CompletionItem> => {
		switch (item.kind) {
			case CompletionItemKind.Function:
			case CompletionItemKind.Method:
			case CompletionItemKind.Class:
				// provide addition infomation of class and function
				item.detail = item.data;
				break;
			case CompletionItemKind.Variable:
				// if this is a `built-in` variable
				// provide the document of it
				if (item.detail === 'Built-in Variable') {
					// TODO: configuration for each document.
					let uri = documents.all()[0].uri;
					let cfg = await documentSettings.get(uri);
					if (cfg?.documentLanguage === docLangName.CN)
					// item.data contains the infomation index(in builtin_variable)
					// of variable
					item.documentation = {
						kind: 'markdown',
						value: builtin_variable[item.data][1]
					};
				}
			default:
				break;
		}
		return item;
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
connection.console.log('Starting AHK Server')
