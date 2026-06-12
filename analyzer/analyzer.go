package main

import (
	"bufio"
	"cmp"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"slices"
)

type Request struct {
	ID      string `json:"id"`
	File    string `json:"file"`
	Content string `json:"content"`
}

type Response struct {
	ID     string      `json:"id"`
	File   string      `json:"file"`
	Scopes []LockScope `json:"scopes"`
	Error  string      `json:"error,omitempty"`
}

type LockScope struct {
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	VarName   string `json:"varName"`
	LockType  string `json:"lockType"` // "Lock" or "RLock"
}

type lockEvent struct {
	pos      token.Pos
	line     int
	varName  string
	isLock   bool
	isDefer  bool
	lockType string
}

func main() {
	fmt.Fprintln(os.Stderr, "Gomu Go daemon starting up...")

	scanner := bufio.NewScanner(os.Stdin)

	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 10*1024*1024)

	encoder := json.NewEncoder(os.Stdout)

	var req Request

	for scanner.Scan() {
		err := json.Unmarshal(scanner.Bytes(), &req)
		if err != nil {
			fmt.Fprintf(os.Stderr, "JSON unmarshal error: %v\n", err)

			continue
		}

		fmt.Fprintf(os.Stderr, "Processing request %s for %s\n", req.ID, req.File)

		scopes, err := processFile(req.File, []byte(req.Content))

		res := Response{
			ID:     req.ID,
			File:   req.File,
			Scopes: scopes,
		}

		if err != nil {
			fmt.Fprintf(os.Stderr, "Process file error: %v\n", err)

			res.Error = err.Error()
		} else {
			fmt.Fprintf(os.Stderr, "Successfully processed file. Found %d scopes.\n", len(scopes))
		}

		err = encoder.Encode(res)
		if err != nil {
			fmt.Fprintf(os.Stderr, "JSON encode error: %v\n", err)
		}
	}

	err := scanner.Err()
	if err != nil {
		fmt.Fprintf(os.Stderr, "stdin scanner error: %v\n", err)

		os.Exit(1)
	}
}

func processFile(filePath string, content []byte) ([]LockScope, error) {
	fset := token.NewFileSet()

	file, err := parser.ParseFile(fset, filePath, content, parser.ParseComments|parser.AllErrors)
	if file == nil {
		return nil, err
	}

	var allScopes []LockScope

	ast.Inspect(file, func(n ast.Node) bool {
		if n == nil {
			return true
		}

		var (
			body   *ast.BlockStmt
			endPos token.Pos
		)

		switch fn := n.(type) {
		case *ast.FuncDecl:
			body = fn.Body
			endPos = fn.End()
		case *ast.FuncLit:
			body = fn.Body
			endPos = fn.End()
		}

		if body != nil {
			scopes := analyzeFunctionBody(fset, body, endPos)

			allScopes = append(allScopes, scopes...)
		}

		return true
	})

	return allScopes, nil
}

func analyzeFunctionBody(fset *token.FileSet, body *ast.BlockStmt, funcEnd token.Pos) []LockScope {
	events := make([]lockEvent, 0, 8)

	funcEndLine := fset.Position(funcEnd).Line

	var inspectBody func(ast.Node) bool

	inspectBody = func(n ast.Node) bool {
		if n == nil {
			return true
		}
		switch stmt := n.(type) {
		case *ast.FuncLit:
			return false
		case *ast.ExprStmt:
			call, ok := stmt.X.(*ast.CallExpr)
			if ok {
				evt, ok := extractLockEvent(fset, call, false)
				if ok {
					events = append(events, evt)
				}
			}
		case *ast.DeferStmt:
			evt, ok := extractLockEvent(fset, stmt.Call, true)
			if ok {
				events = append(events, evt)
			}
		}
		return true
	}

	ast.Inspect(body, inspectBody)

	if len(events) == 0 {
		return nil
	}

	slices.SortFunc(events, func(a, b lockEvent) int {
		return cmp.Compare(a.pos, b.pos)
	})

	scopes := make([]LockScope, 0, len(events)/2)

	var stack []lockEvent

	for _, evt := range events {
		if evt.isLock {
			stack = append(stack, evt)
		} else {
			// Search from top of stack to handle nested locks on different variables
			for i := len(stack) - 1; i >= 0; i-- {
				if stack[i].varName == evt.varName && stack[i].lockType == evt.lockType {
					startLine := stack[i].line
					endLine := evt.line

					if evt.isDefer {
						endLine = max(funcEndLine-1, startLine)
					}

					scopes = append(scopes, LockScope{
						StartLine: startLine,
						EndLine:   endLine,
						VarName:   evt.varName,
						LockType:  evt.lockType,
					})

					// Remove matched lock from stack
					stack = append(stack[:i], stack[i+1:]...)

					break
				}
			}
		}
	}

	return scopes
}

func extractLockEvent(fset *token.FileSet, call *ast.CallExpr, isDefer bool) (lockEvent, bool) {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return lockEvent{}, false
	}

	methodName := sel.Sel.Name

	var (
		isLock   bool
		lockType string
	)

	switch methodName {
	case "Lock":
		isLock, lockType = true, "Lock"
	case "RLock":
		isLock, lockType = true, "RLock"
	case "Unlock":
		isLock, lockType = false, "Lock"
	case "RUnlock":
		isLock, lockType = false, "RLock"
	default:
		return lockEvent{}, false
	}

	return lockEvent{
		pos:      call.Pos(),
		line:     fset.Position(call.Pos()).Line,
		varName:  recvString(sel.X),
		isLock:   isLock,
		isDefer:  isDefer,
		lockType: lockType,
	}, true
}

func recvString(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.Ident:
		return e.Name
	case *ast.SelectorExpr:
		return recvString(e.X) + "." + e.Sel.Name
	case *ast.IndexExpr:
		return recvString(e.X) + "[...]"
	case *ast.ParenExpr:
		return recvString(e.X)
	}

	return ""
}
