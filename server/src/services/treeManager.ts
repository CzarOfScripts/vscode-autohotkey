import {
	CompletionItem,
	CompletionItemKind,
    Definition,
    IConnection,
    Location,
	ParameterInformation,
	Position,
	Range,
	SignatureHelp,
	SignatureInformation,
	SymbolInformation,
	SymbolKind
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { 
    IFuncNode,
	ReferenceInfomation, 
	ISymbolNode, 
	Word,
    ReferenceMap
} from '../parser/regParser/types';
import {
	INodeResult, 
	IFunctionCall, 
	IMethodCall, 
	IPropertCall, 
	IAssign, 
	IASTNode, 
	FunctionCall,
	MethodCall,
    ICommandCall,
    CommandCall
} from '../parser/regParser/asttypes';
import { SemanticStack, isExpr } from '../parser/regParser/semantic_stack';
import { 
    BuiltinFuncNode,
    buildBuiltinFunctionNode,
    buildBuiltinCommandNode
} from '../utilities/constants';
import {
    dirname,
    extname,
    normalize
} from 'path';
import { homedir } from "os";
import { IoEntity, IoKind, IoService } from './ioService';
import { SymbolTable } from '../parser/newtry/analyzer/models/symbolTable';
import { AHKParser } from '../parser/newtry/parser/parser';
import { PreProcesser } from '../parser/newtry/analyzer/semantic';
import { IAST } from '../parser/newtry/types';
import { IScoop, ISymbol, VarKind } from '../parser/newtry/analyzer/types';
import { AHKMethodSymbol, AHKObjectSymbol, AHKSymbol, HotkeySymbol, HotStringSymbol, ScopedSymbol, VaribaleSymbol } from '../parser/newtry/analyzer/models/symbol';

// if belongs to FuncNode
function isFuncNode(node: ISymbolNode): node is IFuncNode{
    return typeof (node as IFuncNode)['params'] !== 'undefined';
}

function setDiffSet<T>(set1: Set<T>, set2: Set<T>) {
    let d12: Array<T> = [], d21: Array<T> = [];
    for(let item of set1) {
        if (!set2.has(item)) {
            d12.push(item);
        }
    }
    for(let item of set2) {
        if (!set1.has(item)) {
            d21.push(item);
        }
    }
    return [d12, d21];
}

export class TreeManager
{
    private conn: IConnection;
	/**
	 * server cached documnets
	 */
	private serverDocs: Map<string, TextDocument>;
	/**
	 * server cached ahk config
	 * TODO: need finish
	 */
	private serverConfigDoc?: TextDocument;
	/**
	 * server cached AST for documents, respectively 
     * Map<uri, IDocmentInfomation>
	 */
    private docsAST: Map<string, DocInfo>;
    /**
     * local storaged AST of ahk documents, cached included documents
     */
    private localAST: Map<string, DocInfo>;

    /**
     * Server cached include informations for each documents
     * Map<DocmemtsUri, Map<IncludeAbsolutePath, RawIncludePath>>
     */
    private incInfos: Map<string, Map<string, string>>;

    private logger: ILoggerBase;

    private ioService: IoService;
    
    /**
     * built-in standard function AST
     */
	private readonly builtinFunction: BuiltinFuncNode[];
    
    /**
     * builtin standard command AST
     */
    private readonly builtinCommand: BuiltinFuncNode[];

    private currentDocUri: string;
    
    /**
     * Standard Library directory
     */
    private readonly SLibDir: string;
    
    /**
     * User library directory
     */
    private readonly ULibDir: string;

	constructor(conn: IConnection, logger: ILoggerBase) {
        this.conn = conn;
		this.serverDocs = new Map();
        this.docsAST = new Map();
        this.localAST = new Map();
        this.incInfos = new Map();
        this.ioService = new IoService();
		this.builtinFunction = buildBuiltinFunctionNode();
        this.builtinCommand = buildBuiltinCommandNode();
		this.serverConfigDoc = undefined;
        this.currentDocUri = '';
        // TODO: non hardcoded Standard Library
        this.SLibDir = 'C:\\Program Files\\AutoHotkey\\Lib'
        this.ULibDir = homedir() + '\\Documents\\AutoHotkey\\Lib'
        this.logger = logger;
    }
    
    /**
     * Initialize information of a just open document
     * @param uri Uri of initialized document
     * @param doc TextDocument of initialized documnet
     */
    public initDocument(uri: string, doc: TextDocument) {
        this.currentDocUri = uri;
        // this.updateDocumentAST(uri, doc);
    }

    /**
     * Select a document for next steps. For provide node infomation of client requests
     * @param uri Uri of document to be selected
     */
	public selectDocument(uri: string) {
		this.currentDocUri = this.serverDocs.has(uri) ? uri : '';
		return this;
    }
    
    /**
     * Update infomation of a given document, will automatic load its includes
     * @param uri Uri of updated document
     * @param docinfo AST of updated document
     * @param doc TextDocument of update documnet
     */
	public async updateDocumentAST(uri: string, doc: TextDocument) {
        // update documnet
        this.serverDocs.set(uri, doc);
        const parser = new AHKParser(doc.getText(), doc.uri, this.logger);
        const ast = parser.parse();
        const preprocesser = new PreProcesser(ast.script);
        const mainTable = preprocesser.process();
        const docTable = mainTable.table;

        // updata AST first, then its includes
        const oldInclude = this.docsAST.get(uri)?.AST.script.include;
        // this.conn.sendDiagnostics({
        //     uri: uri,
        //     diagnostics: mainTable.diagnostics
        // });

        // Store AST first, before await document load
        // In case of other async function run ahead
        this.docsAST.set(uri, {
            AST: ast,
            table: docTable
        });
        
        let useneed, useless: string[];
        if (oldInclude && ast.script.include) {
            // useless need delete, useneed need to add
            // FIXME: delete useless include
            [useless, useneed] = setDiffSet(oldInclude, ast.script.include);
        }
        else {
            useneed = ast.script.include ? [... ast.script.include] : [];
            useless = [];
        }
        // delete unused incinfo
        let incInfo = this.incInfos.get(doc.uri);
        if (incInfo) {
            let tempInfo: string[] = [];
            // acquire absulte uri to detele 
            for (const uri of useless) {
                for (const [abs, raw] of incInfo) {
                    if (raw === uri)
                        tempInfo.push(abs);
                }
            }
            for (const abs of tempInfo)
                incInfo.delete(abs);
        } 

        if (useneed.length === 0) {
            // just link its include and go.
            this.linkInclude(docTable, uri);
            return
        }
        // EnumIncludes
        let incQueue: string[] = [...useneed];
        // this code works why?
        // no return async always fails?
        let path = incQueue.shift();
        while (path) {
            const docDir = dirname(URI.parse(this.currentDocUri).fsPath);
            let p = this.include2Path(path, docDir);
            if (!p || this.localAST.has(URI.file(p).toString())) {
                path = incQueue.shift();
                continue;
            }
            // if is lib include, use lib dir
            // 我有必要一遍遍读IO来确认库文件存不存在吗？
            
            const doc = await this.loadDocumnet(p);
            if (doc) {
                const parser = new AHKParser(doc.getText(), doc.uri, this.logger);
                const ast = parser.parse();
                const preprocesser = new PreProcesser(ast.script);
                const table = preprocesser.process();
                // cache to local storage file AST
                this.localAST.set(doc.uri, {
                    AST: ast,
                    table: table.table
                });
                // TODO: Correct document include tree
                if (this.incInfos.has(uri))
                    this.incInfos.get(uri)?.set(p, path);
                else
                    this.incInfos.set(uri, new Map([[p, path]]));
                incQueue.push(...Array.from(ast.script.include || []));
            }
            path = incQueue.shift();
        }
        // 一顿操作数组和解析器了之后，
        // 这个table和docinfo里的table之间的引用怎么没了得
        // 神秘
        this.linkInclude(docTable, uri);
        this.docsAST.set(uri, {
            AST: ast,
            table: docTable
        });
    }
    
    /**
     * Load and parse a set of documents. Used for process ahk includes
     * @param documnets A set of documents' uri to be loaded and parsed
     */
    private async loadDocumnet(path: string): Promise<Maybe<TextDocument>>  {
        const uri = URI.file(path);
        try {
            const c = await this.retrieveResource(uri);
            let document = TextDocument.create(uri.toString(), 'ahk', 0, c);
            return document
        }
        catch (err) {
            // TODO: log exception here
            return undefined;
        }
    }

    private linkInclude(table: SymbolTable, uri: string) {
        const includes = this.incInfos.get(uri);
        if (!includes) return; 
        for (const [path, raw] of includes) {
            const incUri = URI.file(path).toString();
            const incTable = this.localAST.get(incUri);
            if (!incTable) continue;
            table.addInclude(incTable.table);
        }
    }

	public deleteUnusedDocument(uri: string) {
        let incinfo = this.incInfos.get(uri);
        this.docsAST.delete(uri);
        this.incInfos.delete(uri);
        if (incinfo) {
            for (const [path, raw] of incinfo) {
                let isUseless: boolean = true;
                for (const [docuri, docinc] of this.incInfos) {
                    if (docinc.has(path)) {
                        isUseless = false;
                        break;
                    }
                }
                if (isUseless) this.localAST.delete(URI.file(path).toString());
            }
        }
	}

    /**
   * Retrieve a resource from the provided uri
   * @param uri uri to load resources from
   */
    private retrieveResource(uri: URI): Promise<string> {
        const path = uri.fsPath;
        return this.ioService.load(path);
    }

    /**
     * Return a line of text up to the given position
     * @param position position of end mark
     */
	private LineTextToPosition(position: Position): Maybe<string> {
		if (this.currentDocUri) {
			return this.serverDocs
				.get(this.currentDocUri)
				?.getText(Range.create(
					Position.create(position.line, 0),
					position
				)).trimRight();
		}
    }
    
    /**
     * Return the text of a given line
     * @param line line number
     */
    private getLine(line: number): Maybe<string> {
        if (this.currentDocUri) {
			return this.serverDocs
				.get(this.currentDocUri)
				?.getText(Range.create(
					Position.create(line, 0),
					Position.create(line+1, 0)
				)).trimRight();
		}
    }

    private include2Path(rawPath: string, scriptPath: string): Maybe<string> {
        const scriptDir = scriptPath;
        const normalized = normalize(rawPath);
        switch (extname(normalized)) {
            case '.ahk':
                if (dirname(normalized)[0] === '.') // if dir start as ../ or .
                    return normalize(scriptDir + '\\' + normalized);
                else    // absolute path
                    return normalized;
            case '':
                if (rawPath[0] === '<' && rawPath[rawPath.length-1] === '>') {
                    let searchDir: string[] = []
                    const np = normalize(rawPath.slice(1, rawPath.length-1)+'.ahk');
                    const dir = normalize(scriptDir + '\\Lib\\' + np);
                    const ULibDir = normalize(this.ULibDir + '\\' + np);
                    const SLibDir = normalize(this.SLibDir + '\\' + np);
                    searchDir.push(dir, ULibDir, SLibDir);
                    for(const d of searchDir) {
                        if (this.ioService.fileExistsSync(d))
                            return d;
                    }
                }
                // TODO: handle include path change
                return undefined;
            default:
                return undefined;
        }
    }

    /**
     * A simple(vegetable) way to get all include AST of a document
     * @returns SymbolNode[]-ASTs, document uri
     */
    private allIncludeTreeinfomation(docinfo: DocInfo): DocInfo[] {
        const incInfo = this.incInfos.get(this.currentDocUri) || [];
        let r: DocInfo[] = [];
        for (const [path, raw] of incInfo) {
            const uri = URI.file(path).toString();
            const incDocInfo = this.localAST.get(uri);
            if (incDocInfo) {
                r.push(incDocInfo);
            }
        }    
        return r;
    }

    public docSymbolInfo(): SymbolInformation[] {
        const info = this.docsAST.get(this.currentDocUri);
        if (!info) return [];
        return info.table.symbolInformations();
    }

    /**
     * Returns a string in the form of the function node's definition
     * @param symbol Function node to be converted
     * @param cmdFormat If ture, return in format of command
     */
    public getFuncPrototype(symbol: IFuncNode|BuiltinFuncNode, cmdFormat: boolean = false): string {
        const paramStartSym = cmdFormat ? ', ' : '(';
        const paramEndSym = cmdFormat ? '' : ')'
        let result = symbol.name + paramStartSym;
        symbol.params.map((param, index, array) => {
            result += param.name;
            if (param.isOptional) result += '?';
            if (param.defaultVal) result += ' := ' + param.defaultVal;
            if (array.length-1 !== index) result += ', ';
        })
        return result+paramEndSym;
    }

    public convertParamsCompletion(node: ISymbolNode): CompletionItem[] {
        if (node.kind === SymbolKind.Function) {
            let params =  (<IFuncNode>node).params
            return params.map(param => {
                let pc = CompletionItem.create(param.name);
                pc.kind = CompletionItemKind.Variable;
                pc.detail = '(parameter) '+param.name;
                return pc;
            })
        }
        return [];
    }

    public getGlobalCompletion(): CompletionItem[] {
        let incCompletion: CompletionItem[] = [];
        let docinfo: DocInfo|undefined;
        if (this.currentDocUri)
            docinfo = this.docsAST.get(this.currentDocUri);
        if (!docinfo) return [];
        const symbols = docinfo.table.allSymbols();
        // TODO: 应该统一只用this.allIncludeTreeinfomation
        const incInfo = this.incInfos.get(this.currentDocUri) || []
        // 为方便的各种重复存储，还要各种加上累赘代码，真是有点沙雕
        for (let [path, raw] of incInfo) {
            const incUri = URI.file(path).toString();
            // read include file tree from disk file tree caches
            const table = this.localAST.get(incUri)?.table;
            if (table) {
                incCompletion.push(...table.allSymbols().map(node => {
                    let c = this.convertSymCompletion(node);
                    c.data += '  \nInclude from ' + raw;
                    return c;
                }))
            }
        }
        
        return symbols.map(sym => this.convertSymCompletion(sym))
        .concat(this.builtinFunction.map(node => {
            let ci = CompletionItem.create(node.name);
            ci.data = this.getFuncPrototype(node);
            ci.kind = CompletionItemKind.Function;
            return ci;
        }))
        .concat(this.builtinCommand.map(node => {
            let ci = CompletionItem.create(node.name);
            ci.data = this.getFuncPrototype(node, true);
            ci.kind = CompletionItemKind.Function;
            return ci;
        }))
        .concat(incCompletion);
    }

    public getScopedCompletion(pos: Position, keywordCompletions: CompletionItem[], builtinVarCompletions: CompletionItem[]): CompletionItem[] {
        let docinfo: DocInfo|undefined;
        docinfo = this.docsAST.get(this.currentDocUri);
        if (!docinfo) return [];
        const scoop = this.getCurrentScoop(pos, docinfo.table);
        const lexems = this.getLexemsAtPosition(pos);
        if (lexems && lexems.length > 1) {
            const perfixs = lexems.reverse();
            const symbol = this.searchPerfixSymbol(perfixs.slice(0, -1), scoop);
            if (!symbol) return [];
            return symbol.allSymbols().map(sym => this.convertSymCompletion(sym));
        }
        if (scoop.name === 'global') return this.getGlobalCompletion()
                                    .concat(keywordCompletions)
                                    .concat(builtinVarCompletions);
        const symbols = scoop.allSymbols();
        return symbols.map(sym => this.convertSymCompletion(sym))
                .concat(this.getGlobalCompletion())
                .concat(keywordCompletions)
                .concat(builtinVarCompletions);
    }

    /**
     * Find current position is belonged to which scoop
     * @param pos position of current request
     * @param table symbol table of current document
     * @returns Scoop of current position
     */
    private getCurrentScoop(pos: Position, table: IScoop): IScoop {
        const symbols = table.allSymbols();
        for (const sym of symbols) {
            if (sym instanceof AHKMethodSymbol || sym instanceof AHKObjectSymbol) {
                if (this.isLessPosition(sym.range.start, pos)
                    && this.isLessPosition(pos, sym.range.end) ) {
                    return this.getCurrentScoop(pos, sym);
                }
            }
        }
        // no matched scoop return position is belongs to its parent scoop
        return table;
    }

    /**
     * Return if pos1 is before pos2
     * @param pos1 position 1
     * @param pos2 position 2
     */
    private isLessPosition(pos1: Position, pos2: Position): boolean {
        if (pos1.line < pos2.line) return true;
        if (pos1.line === pos2.line && pos1.character < pos1.character) 
            return true;
        return false;
    }

    public includeDirCompletion(position: Position): Maybe<CompletionItem[]> {
        const context = this.LineTextToPosition(position);
        const reg = /^\s*#include/i;
        if (!context) return undefined;
        let match = context.match(reg);
        if (!match) return undefined;
        // get dir text
        const p = context.slice(match[0].length).trim();
        const docDir = dirname(URI.parse(this.currentDocUri).fsPath);
        let searchDir: string[] = []
        // if is lib include, use lib dir
        if (p[0] === '<') {
            const np = normalize(p.slice(1));
            const dir = normalize(docDir + '\\Lib\\' + np);
            const ULibDir = normalize(this.ULibDir + '\\' + np);
            const SLibDir = normalize(this.SLibDir + '\\' + np);
            searchDir.push(dir, ULibDir, SLibDir);
        } 
        else {
            const dir = normalize(docDir + '\\' + normalize(p));
            searchDir.push(dir);
        }
        let completions: IoEntity[] = []
        for (const dir of searchDir) {
            completions.push(...this.ioService.statDirectory(dir));
            // If is not '#include <', because of library search order 
            // we must not search all directory. Once we found an exist directory, 
            // we return it
            if (completions.length > 0 && p !== '<') break;
        }
        return completions.map((completion):CompletionItem => {
            let c = CompletionItem.create(completion.path);
            c.kind = completion.kind === IoKind.folder ? 
                     CompletionItemKind.Folder :
                     CompletionItemKind.File;
            return c;
        }
        );
    }

    /**
     * All words at a given position(top scope at last)
     * @param position 
     */
    private getLexemsAtPosition(position: Position): Maybe<string[]> {
        const context = this.getLine(position.line);
        if (!context) return undefined;
        let suffix = this.getWordAtPosition(position);
        let perfixs: string[] = [];
        let temppos = (suffix.name === '') ? 
                    position.character-1 : // we need pre-character of empty suffix
                    suffix.range.start.character-1;

        // Push perfixs into perfixs stack
        while (this.getChar(context, temppos) === '.') {
            // FIXME: correct get word here 
            let word = this.getWordAtPosition(Position.create(position.line, temppos-1));
            perfixs.push(word.name);
            temppos = word.range.start.character-1;
        }
        return [suffix.name].concat(perfixs);
    }
    
    /**
     * Get suffixs list of a given perfixs list
     * @param perfixs perfix list for search(top scope at first)
     */
    private searchPerfixSymbol(perfixs: string[], scoop: IScoop): Maybe<AHKObjectSymbol> {
        let nextScoop = scoop.resolve(perfixs[0]);
        if (nextScoop && nextScoop instanceof AHKObjectSymbol) {
            for (const lexem of perfixs.slice(1)) {
                nextScoop = nextScoop.resolveProp(lexem);
                if (nextScoop && nextScoop instanceof AHKObjectSymbol) 
                    scoop = nextScoop;
                else 
                    return undefined;
            }
            return nextScoop;
        }
        return undefined;
    }

    /**
     * Get node of position and lexems
     * @param lexems all words strings(这次call，全部的分割词)
     * @param position position of qurey word(这个call的位置)
     */
    private searchNode(lexems: string[], position: Position): Maybe<ISymbol> {
        const docinfo = this.docsAST.get(this.currentDocUri);
        if (!docinfo) return undefined;
        const scoop = this.getCurrentScoop(position, docinfo.table);
        if (lexems.length > 1) {
            // check if it is a property access
            const perfixs = lexems.reverse().slice(0, -1);
            const symbol = this.searchPerfixSymbol(perfixs, scoop);
            return symbol ? symbol.resolveProp(lexems[lexems.length-1]) : undefined;
        }
        
        return scoop.resolve(lexems[0]);
    }


    /**
     * search at given tree to 
     * find the deepest node that
     * covers the given condition
     *  
     * @param pos position to search
     * @param tree AST tree for search
     * @param kind symbol kind of search item
     */
    public searchNodeAtPosition(pos: Position, tree: Array<ISymbolNode|IFuncNode>, kind?:SymbolKind): Maybe<ISymbolNode|IFuncNode> {
        for (const node of tree) {
            if (pos.line > node.range.start.line && pos.line < node.range.end.line) {
                if (node.subnode) {
                    if (kind && !(node.kind === kind)) {
                       continue;
                    }
                    let subScopedNode = this.searchNodeAtPosition(pos, node.subnode, kind);
                    if (subScopedNode) {
                        return subScopedNode;
                    } 
                    else {
                        return node;
                    }
                }
            }
        }
        return undefined;
    }

    /**
     * Convert a symbol to comletion item
     * @param sym symbol to be converted
     */
    public convertSymCompletion(sym: ISymbol): CompletionItem {
		let ci = CompletionItem.create(sym.name);
		if (sym instanceof AHKMethodSymbol) {
			ci['kind'] = CompletionItemKind.Method;
            sym.requiredParameters
			ci.data = sym.toString();
		} else if (sym instanceof VaribaleSymbol) {
			ci.kind = sym.tag === VarKind.property ? 
                      CompletionItemKind.Property :
                      CompletionItemKind.Variable;
		} else if (sym instanceof AHKObjectSymbol) {
			ci['kind'] = CompletionItemKind.Class;
			ci.data = ''
		} else if (sym instanceof HotkeySymbol || sym instanceof HotStringSymbol) {
			ci['kind'] = CompletionItemKind.Event;
		} else {
			ci['kind'] = CompletionItemKind.Text;
		} 
		return ci;
	}

    public getFuncAtPosition(position: Position): Maybe<SignatureHelp> {
		let context = this.LineTextToPosition(position);
		if (!context) return undefined;

        // check if we need to attach to previous lines
        const attachToPreviousTest = new RegExp('^[ \t]*,');
        if (attachToPreviousTest.test(context)) {
            let linenum = position.line-1;
            let lines: Maybe<string> = this.getLine(linenum);
            context = lines + context;
            while (lines) {
                if (attachToPreviousTest.test(lines)) {
                    linenum -= 1;
                    lines = this.getLine(linenum);
                    context = lines + context;
                } 
                else
                    lines = undefined;
            }
        }

        let stmtStack = new SemanticStack(context);
        let stmt: INodeResult<IFunctionCall| IMethodCall | IPropertCall | IAssign | ICommandCall>|undefined;
        try {
            stmt = stmtStack.statement();
        }
        catch (err) {
            return undefined;
        }
        if (!stmt) {
            return undefined;
        }
        let perfixs: string[] = [];
        
        let node: INodeResult<IASTNode> = stmt;
        if (isExpr(stmt.value)) {
            node = stmt.value.right;
            while(isExpr(node.value)) {
                node = node.value.right;
            }
        }
        
        stmt = node as INodeResult<IFunctionCall | IMethodCall | IPropertCall | IAssign | ICommandCall>;
        
        if (stmt.value instanceof FunctionCall ) {
            // CommandCall always no errors
            if (!stmt.errors && !(stmt.value instanceof CommandCall)) {
                return undefined;
            }
            let lastnode = this.getUnfinishedFunc(stmt.value);
            if (!lastnode) {
                lastnode = stmt.value;
            } 
            if (lastnode instanceof MethodCall) {
                perfixs = lastnode.ref.map(r => {
                    return r.content;
                });
            }

            const funcName = lastnode.name;
            let index = lastnode.actualParams.length===0 ?
                        null: lastnode.actualParams.length-1;
            if (lastnode instanceof CommandCall) {
                // All Commands are built-in, just search built-in Commands
                const bfind = arrayFilter(this.builtinCommand, item => item.name.toLowerCase() === funcName.toLowerCase());
                const info = this.convertBuiltin2Signature(bfind, true);
                if (info) {
                    return {
                        signatures: info,
                        activeParameter: index,
                        activeSignature: this.findActiveSignature(bfind, lastnode.actualParams.length)
                    }
                }
            }
            let find = this.searchNode([funcName].concat(...perfixs.reverse()), position);
            // if no find, search build-in
            if (!find) {
                const bfind = arrayFilter(this.builtinFunction, item => item.name.toLowerCase() === funcName.toLowerCase());
                const info = this.convertBuiltin2Signature(bfind);
                if (info) {
                    return {
                        signatures: info,
                        activeParameter: index,
                        activeSignature: this.findActiveSignature(bfind, lastnode.actualParams.length)
                    }
                }
            }
            if (find instanceof AHKMethodSymbol) {
                const reqParam: ParameterInformation[] = find.requiredParameters.map(param => ({
                    label: param.name
                }));
                const optParam: ParameterInformation[] = find.optionalParameters.map(param => ({
                    label: param.name+'?'
                }));
                return {
                    signatures: [SignatureInformation.create(
                        find.toString(),
                        undefined,
                        ...reqParam,
                        ...optParam
                    )],
                    activeSignature: 0,
                    activeParameter: index
                };
            }
        }
    }

    /**
     * Find the deepest unfinished Function of a AST node
     * @param node Node to be found
     */
    private getUnfinishedFunc(node: IFunctionCall): Maybe<IFunctionCall> {
        let perfixs: string[]|undefined;
        let lastParam = node.actualParams[node.actualParams.length-1];
        // no-actual-parameter check 
        if (!lastParam || !lastParam.errors) {
            return undefined;
        }
        if (lastParam.value instanceof FunctionCall) {
            let lastnode = this.getUnfinishedFunc(lastParam.value);
            if (lastnode) {
                if (node instanceof FunctionCall) {
                    return lastnode
                }
            }
            return lastParam.value;
        }
        return node;
    }

    private convertBuiltin2Signature(symbols: BuiltinFuncNode[], iscmd: boolean = false): Maybe<SignatureInformation[]> {
        if (symbols.length === 0)
            return undefined;
        const info: SignatureInformation[] = [];
        for (const sym of symbols) {
            const paraminfo: ParameterInformation[] = sym.params.map(param => ({
                label: `${param.name}${param.isOptional ? '?' : ''}${param.defaultVal ? ' = '+param.defaultVal: ''}`
            }))
            info.push(SignatureInformation.create(
                this.getFuncPrototype(sym, iscmd),
                undefined,
                ...paraminfo
            ))
        }
        return info;
    }

    /**
     * Find which index of signatures is active
     * @param symbols symbols to be found
     * @param paramIndex active parameter index
     * @returns active signature index
     */
    private findActiveSignature(symbols: BuiltinFuncNode[], paramIndex: number): number {
        for (let i = 0; i < symbols.length; i++) {
            const sym = symbols[i];
            if (sym.params.length >= paramIndex)
                return i;
        }
        return 0;
    }

    public getDefinitionAtPosition(position: Position): Location[] {
        let lexems = this.getLexemsAtPosition(position);
        if (!lexems) return [];
        const symbol = this.searchNode(lexems, position);
        if (!symbol) return [];
        let locations: Location[] = [];
        if (symbol instanceof VaribaleSymbol ||
            symbol instanceof AHKMethodSymbol ||
            symbol instanceof AHKObjectSymbol)
            locations.push(Location.create(
                symbol.uri,
                symbol.range
            ));
        return locations;
    }

    private getWordAtPosition(position: Position): Word {
        let reg = /[a-zA-Z0-9\u4e00-\u9fa5#_@\$\?]+/;
		const context = this.getLine(position.line);
		if (!context)
			return Word.create('', Range.create(position, position));
        let wordName: string;
        let start: Position;
        let end: Position;
        let pos: number;

        pos = position.character;
        // Scan start
        // Start at previous character
        // 从前一个字符开始
        while (pos >= 0) {
            if(reg.test(this.getChar(context, pos-1)))
                pos -= 1;
            else
                break;
        }

        start = Position.create(position.line, pos);

        pos = position.character
        // Scan end
        while (pos <= context.length) {
            if(reg.test(this.getChar(context, pos)))
                pos += 1;
            else
                break;
        }
        
        end = Position.create(position.line, pos);
        wordName = context.slice(start.character, end.character);
        return Word.create(wordName, Range.create(start, end));
    }

    private getChar(context: string, pos: number): string {
        try {
            // if (context[pos] === '\r' || context[pos] === '\t')
            return context[pos] ? context[pos] : '';
        } catch (err) {
            return '';
        }
	}
}

/**
 * Get eligible items in the array(找到数组中符合callback条件的项)
 * @param list array to be filted
 * @param callback condition of filter
 */
function arrayFilter<T>(list: Array<T>, callback: (item: T) => boolean): T[] {
    let flag = false;
    const items: T[] = [];

    // search a continueous block of symbols
    for (const item of list) {
        if (callback(item)) {
            items.push(item);
            flag = true;
        }
        else if (flag === true) 
            break;
    }
    return items;
}

interface DocInfo {
    AST: IAST;
    table: SymbolTable;
}

interface NodeInfomation {
    symbol: ISymbol;
    uri: string;
}