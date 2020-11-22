/**
 * Generate a parse stack of parsing process,
 * not for a real parser.
 * But, for language server providers.
 * Only parse a line.
 */

import { createToken, Token, TokenType } from './utilities/types';
import { Tokenizer } from './tokenizer'
import { 
    IAssign,
    IASTNode,
    IBinOp,
    IFunctionCall,
    IMethodCall,
    INodeResult,
    IOffRange,
    IPropertCall,
    IVariable,
    INoOpt,
    Offrange,
    FunctionCall,
    PropertCall,
    MethodCall,
    IUnaryOperator,
    ILiteral,
    Expr
 } from "./asttypes";

export function isExpr(node: IASTNode): node is IBinOp {
    if ((node as IBinOp)['right'] === undefined) {
        return false;
    }
    return true;
}

export class SemanticStack {
    private tokenizer: Tokenizer;
    private currentToken: Token;

    constructor(document: string) {
        this.tokenizer = new Tokenizer(document);
        this.currentToken = this.tokenizer.GetNextToken();
    }

    reset(document: string) {
        this.tokenizer.Reset(document);
        return this;
    }

    eat(type: TokenType) {
        if (type === this.currentToken.type) {
            this.currentToken = this.tokenizer.GetNextToken();
        } 
        else {
            throw new Error("Unexpect Token");
        }
    }

    variable(): INodeResult<IVariable> {
        let token = this.currentToken;
        this.eat(TokenType.id);
        return {
            errors: false,
            value: {
                name: token.content,
                token: token,
                offrange: new Offrange(token.start, token.end)
            }
        };
    }

    literal(): INodeResult<ILiteral> {
        let token = this.currentToken;
        if (this.currentToken.type === TokenType.string) {
            this.eat(TokenType.string);
        } 
        else if (this.currentToken.type === TokenType.number) {
            this.eat(TokenType.number);
        }
        return {
            errors: false,
            value: {
                token: token,
                value: token.content,
                offrange: new Offrange(token.start, token.end)
            }
        };
    }

    // For this is simple parser, we don't care about operator level
    factor(): Expr{
        let token = this.currentToken
        let node: Expr;
        switch (this.currentToken.type) {
            case TokenType.string:
            case TokenType.number:
                return this.literal();
            case TokenType.plus:
            case TokenType.minus:
                this.eat(this.currentToken.type);
                let exp = this.expr();
                return {
                    errors: false, 
                    value: {
                        operator: token, 
                        expr: exp, 
                        offrange: new Offrange(token.start, exp.value.offrange.end)
                    }
                };
            case TokenType.new:
                this.eat(TokenType.new);
                // new a class like a function call
                if (this.tokenizer.currChar === '(') {
                    let node = this.funcCall();
                    return {
                        errors: node.errors,
                        value: new MethodCall(
                            '__New',
                            node.value.actualParams,
                            node.value.token,
                            [node.value.token],
                            node.value.offrange
                        )
                        
                    };
                }
                // new a class like a class call
                else if (this.tokenizer.currChar === '.') {
                    let node = this.classCall();
                    let vnode = node.value;
                    vnode.ref.push(vnode.token);
                    if (vnode instanceof MethodCall) {
                        return {
                            errors: node.errors,
                            value: new MethodCall(
                                '__New',
                                vnode.actualParams,
                                vnode.token,
                                vnode.ref,
                                vnode.offrange
                            )
                        };  
                    }
                    else {
                        return {
                            errors: node.errors,
                            value: new MethodCall(
                                '__New',
                                [],             // new like property call does not have parameters
                                vnode.token,
                                vnode.ref,
                                vnode.offrange
                            )
                        };  
                    }
                }
                // new a class just by it name
                else {
                    if (token.type === TokenType.id) {
                        this.eat(TokenType.id);
                        return {
                            errors: false,
                            value: new MethodCall(
                                '__New',
                                [],             // new like property call does not have parameters
                                token,
                                [token],
                                new Offrange(token.start, token.end)
                            )
                        };
                    }
                    else {
                        // got wrong in new class
                        return {
                            errors: true,
                            value: new MethodCall(
                                '__New',
                                [],             // new like property call does not have parameters
                                createToken(TokenType.unknown, '', token.start, token.end),
                                [],
                                new Offrange(token.start, token.end)
                            )
                        };
                    }
                      
                }
            case TokenType.openParen:
                this.eat(TokenType.openParen);
                node = this.expr();
                this.eat(TokenType.closeParen);
                return node;
            default:
                switch (this.tokenizer.currChar) {
                    case '(':
                        node = this.funcCall();
                        break;
                    case '.':
                        node = this.classCall();
                        break;
                    default:
                        node = this.variable();
                        break;
                }
                return node;
        }
    }

    expr(): Expr {
        // while (this.currentToken.type !== TokenType.id && this.currentToken.type !== TokenType.comma) {
        //     this.eat(this.currentToken.type);
        // }
        try {
            let left = this.factor();
            let node: Expr = {
                errors: left.errors,
                value: left.value
            };
            
            while ((this.currentToken.type >= TokenType.number  && // all allowed operator
                    this.currentToken.type <= TokenType.less)   ||
                   this.currentToken.type === TokenType.dot     || 
                   this.currentToken.type === TokenType.unknown) {
                let token = this.currentToken;
                // Implicit connection expression
                if (this.currentToken.type >= TokenType.number && this.currentToken.type <= TokenType.id) {
                    token = {
                        content: '',
                        type: TokenType.unknown,
                        start: this.currentToken.start,
                        end: this.currentToken.start
                    }
                }
                this.eat(this.currentToken.type);
                const right: Expr = this.expr()
                node = {
                    errors: false,
                    value: {
                        left: left,
                        operator: token,
                        right: right,
                        offrange: new Offrange(token.start, right.value.offrange.end)
                    }
                }
            }
            return node;
        } 
        catch (err) {
            return {
                errors: true,
                value: {
                    offrange: new Offrange(this.currentToken.start, this.currentToken.end)
                }
            };
        }
    }

    assignment(): INodeResult<IAssign> {
        let left: INodeResult<IVariable|IPropertCall>;
        if (this.tokenizer.currChar === '.') {
            left = this.classCall();
        }
        left = this.variable();
        let isWrong = false;

        let token: Token = this.currentToken;
        if (this.currentToken.type === TokenType.aassign) {
            this.eat(TokenType.aassign);
        }
        try{
            this.eat(TokenType.equal);
            // FIXME: tokenizor should only generate string token here
        }
        catch (err) {
            isWrong = true;
        }
        let exprNode = this.expr();
        return {
            errors: isWrong,
            value: {
                left: left,
                operator: token,
                right: exprNode,
                offrange: new Offrange(token.start, exprNode.value.offrange.end)
            }
        };

    }

    funcCall(): INodeResult<IFunctionCall> {
        let token = this.currentToken;
        let funcName = token.content;
        let iserror = false;

        this.eat(TokenType.id);
        this.eat(TokenType.openParen);
        let actualParams: INodeResult<IBinOp | INoOpt>[] = [];
        if (this.currentToken.type !== TokenType.closeParen) {
            actualParams.push(this.expr());
        }

        while (this.currentToken.type === TokenType.comma) {
            this.eat(TokenType.comma);
            actualParams.push(this.expr());
        }

        const end: number = this.currentToken.end;
        try {
            this.eat(TokenType.closeParen);
        }
        catch (err) {
            iserror = true;
        }
        
        return {
            errors: iserror,
            value: new FunctionCall(funcName, actualParams, token, new Offrange(token.start, end))
        };
    }

    classCall(): INodeResult<IMethodCall|IPropertCall> {
        let classref: Token[] = [this.currentToken];

        this.eat(TokenType.id);
        this.eat(TokenType.dot);
        while (this.currentToken.type === TokenType.id && this.tokenizer.currChar === '.') {
            classref.push(this.currentToken);
            this.eat(TokenType.id);
            this.eat(TokenType.dot);
        }

        let token = this.currentToken;
        if (this.currentToken.type === TokenType.id) {
            if (this.tokenizer.currChar === '(') {
                let callNode = this.funcCall();
                callNode.value.offrange.start = classref[0].start;
                return {
                    errors: callNode.errors,
                    value: new MethodCall(callNode.value.name, 
                                callNode.value.actualParams, 
                                callNode.value.token, 
                                classref, 
                                callNode.value.offrange)
                };
            } 
            this.eat(TokenType.id);
            return {
                errors: false,
                value: new PropertCall(this.currentToken.content, 
                                       this.currentToken, 
                                       classref, 
                                       new Offrange(classref[0].start, token.end))
            };
        }
        return {
            errors: true,
            value: new PropertCall(this.currentToken.content, 
                                   this.currentToken, 
                                   classref, 
                                   new Offrange(classref[0].start, token.end))
        };

    }

    statement() {
        // let node: any;
        // Start at first id
        while (this.currentToken.type !== TokenType.id) {
            if (this.currentToken.type === TokenType.EOF) {
                return undefined;
            }
            this.eat(this.currentToken.type);
        }
        switch (this.currentToken.type) {
            case TokenType.id:
                if (this.tokenizer.currChar === '(') {
                    return this.funcCall();
                } 
                else if (this.tokenizer.currChar === '.') {
                    return this.classCall();
                }
                else {
                    return this.assignment();
                }
                break;
        
            // default:
            //     return []
            //     break;
        }
    }
}