const vscode = require("vscode"),
	{ spawn } = require("node:child_process"),
	path = require("node:path"),
	os = require("node:os"),
	fs = require("node:fs"),
	readline = require("node:readline");

const colors = [
	"editorBracketHighlight.foreground1",
	"editorBracketHighlight.foreground2",
	"editorBracketHighlight.foreground3",
	"editorBracketHighlight.foreground4",
	"editorBracketHighlight.foreground5",
	"editorBracketHighlight.foreground6",
].map(id => new vscode.ThemeColor(id));

const cachedScopes = new Map();

let scopeStepPx = 6,
	scopeBasePx = 6,
	lineWidthPx = 2,
	barTypes = [],
	topCapTypes = [],
	bottomCapTypes = [];

function getConfig() {
	const config = vscode.workspace.getConfiguration("gomu");

	return {
		opacity: config.get("lineOpacity", 75) / 100,
		width: config.get("lineWidth", 2),
		spacing: config.get("lineSpacing", 6),
		baseOffset: config.get("baseOffset", 6),
	};
}

function disposeDecorationTypes() {
	for (const type of [...barTypes, ...topCapTypes, ...bottomCapTypes]) {
		type.dispose();
	}

	barTypes = [];
	topCapTypes = [];
	bottomCapTypes = [];
}

function createCapType(atBottom, config) {
	return colors.map(color =>
		vscode.window.createTextEditorDecorationType({
			before: {
				contentText: "",
				backgroundColor: color,
				width: "0px",
				height: `${config.width}px`,
				textDecoration: `none; position: absolute; opacity: ${config.opacity}; ${atBottom ? "bottom: 0" : "top: 0"};`,
			},
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		})
	);
}

function buildDecorationTypes() {
	const config = getConfig();

	lineWidthPx = config.width;
	scopeBasePx = config.baseOffset;
	scopeStepPx = config.spacing + config.width;

	disposeDecorationTypes();

	barTypes = colors.map(color =>
		vscode.window.createTextEditorDecorationType({
			before: {
				contentText: "",
				backgroundColor: color,
				width: `${config.width}px`,
				height: "100%",
				textDecoration: `none; position: absolute; opacity: ${config.opacity};`,
			},
			overviewRulerColor: color,
			overviewRulerLane: vscode.OverviewRulerLane.Left,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		})
	);

	topCapTypes = createCapType(false, config);
	bottomCapTypes = createCapType(true, config);
}

function refreshVisibleEditors() {
	for (const editor of vscode.window.visibleTextEditors) {
		if (editor.document.languageId !== "go") {
			continue;
		}

		const scopes = cachedScopes.get(editor.document.uri.toString());

		if (scopes) {
			applyDecorations(editor, scopes);
		} else {
			requestAnalysis(editor.document);
		}
	}
}

let debounceTimer = null,
	goDaemon = null,
	reqIdCounter = 0,
	isDeactivating = false,
	restartTimeout = null,
	restartAttempts = 0,
	extensionContext = null,
	outputChannel = null;

function log(message) {
	if (outputChannel) {
		outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	}
}

function activate(context) {
	extensionContext = context;

	outputChannel = vscode.window.createOutputChannel("Gomu");

	context.subscriptions.push(outputChannel);

	log("Gomu extension activated.");

	buildDecorationTypes();

	startDaemon();

	vscode.workspace.onDidChangeConfiguration(
		event => {
			if (event.affectsConfiguration("gomu")) {
				log("Configuration changed, rebuilding decorations.");

				buildDecorationTypes();
				refreshVisibleEditors();
			}
		},
		null,
		context.subscriptions
	);

	vscode.workspace.onDidChangeTextDocument(
		event => {
			if (event.document.languageId !== "go") {
				return;
			}

			clearTimeout(debounceTimer);

			debounceTimer = setTimeout(() => {
				requestAnalysis(event.document);
			}, 250);
		},
		null,
		context.subscriptions
	);

	vscode.workspace.onDidCloseTextDocument(
		document => {
			if (document.languageId === "go") {
				cachedScopes.delete(document.uri.toString());
			}
		},
		null,
		context.subscriptions
	);

	vscode.window.onDidChangeActiveTextEditor(
		editor => {
			if (editor && editor.document.languageId === "go") {
				requestAnalysis(editor.document);
			}
		},
		null,
		context.subscriptions
	);

	if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === "go") {
		requestAnalysis(vscode.window.activeTextEditor.document);
	}
}

function startDaemon() {
	if (isDeactivating) {
		return;
	}

	const platform = os.platform(),
		arch = os.arch(),
		ext = platform === "win32" ? ".exe" : "",
		binName = `gomu-${platform}-${arch}${ext}`;

	const serverCommand = path.join(extensionContext.extensionPath, "bin", binName);

	log(`Checking for binary at: ${serverCommand}`);

	if (!fs.existsSync(serverCommand)) {
		const errMsg = `Gomu binary not found for your platform: ${binName}`;

		log(`ERROR: ${errMsg}`);

		vscode.window.showErrorMessage(errMsg);

		return;
	}

	log(`Spawning daemon process: ${serverCommand}`);

	goDaemon = spawn(serverCommand);

	goDaemon.on("error", err => {
		log(`Go Daemon spawn/runtime error: ${err.message}`);
	});

	goDaemon.on("exit", (code, signal) => {
		goDaemon = null;

		log(`Go daemon exited (code: ${code}, signal: ${signal})`);

		if (!isDeactivating) {
			log("Scheduling daemon restart...");
			scheduleRestart();
		}
	});

	const rl = readline.createInterface({
		input: goDaemon.stdout,
		terminal: false,
	});

	rl.on("line", line => {
		restartAttempts = 0;

		try {
			const response = JSON.parse(line);

			if (response.error) {
				log(`Go Daemon returned analysis error: ${response.error}`);
				return;
			}

			const scopes = response.scopes || [],
				editor = vscode.window.visibleTextEditors.find(e => {
					return path.normalize(e.document.fileName).toLowerCase() === path.normalize(response.file).toLowerCase();
				});

			log(`Received ${scopes.length} scopes for file: ${response.file}`);

			if (editor) {
				cachedScopes.set(editor.document.uri.toString(), scopes);
				applyDecorations(editor, scopes);
			} else {
				log(`No visible editor matched file: ${response.file}`);
			}
		} catch (err) {
			log(`Failed to parse daemon response: ${err.message}. Raw line: ${line}`);
		}
	});

	goDaemon.stderr.on("data", data => {
		log(`Go Daemon stderr: ${data.toString().trim()}`);
	});
}

function scheduleRestart() {
	if (restartTimeout) {
		clearTimeout(restartTimeout);
	}

	const delay = Math.min(1000 * 2 ** restartAttempts, 30000);

	restartAttempts++;

	restartTimeout = setTimeout(() => {
		log(`Restarting Go daemon (attempt ${restartAttempts})...`);

		startDaemon();
	}, delay);
}

function requestAnalysis(document) {
	if (!goDaemon || goDaemon.killed) {
		log("Cannot request analysis: Go daemon is not running.");

		return;
	}

	reqIdCounter++;

	const payload = {
		id: reqIdCounter.toString(),
		file: document.fileName,
		content: document.getText(),
	};

	log(`Sending analysis request #${payload.id} for ${payload.file} (${payload.content.length} chars)`);

	goDaemon.stdin.write(`${JSON.stringify(payload)}\n`);
}

function applyDecorations(editor, scopes) {
	const barRanges = barTypes.map(() => []),
		topCapRanges = barTypes.map(() => []),
		bottomCapRanges = barTypes.map(() => []);

	const tabSize = Number(editor.options.tabSize) || 4;

	if (scopes && scopes.length > 0) {
		scopes.sort((a, b) => a.startLine - b.startLine);

		const activeScopes = [];

		for (const scope of scopes) {
			while (activeScopes.length > 0 && activeScopes[activeScopes.length - 1].endLine < scope.startLine) {
				activeScopes.pop();
			}

			scope.colorIndex = activeScopes.length % barTypes.length;
			scope.column = visualColumn(editor.document, Math.max(1, scope.startLine) - 1, tabSize);

			activeScopes.push(scope);
		}

		for (const scope of scopes) {
			addScopeBar(editor, scopes, barRanges[scope.colorIndex], topCapRanges[scope.colorIndex], bottomCapRanges[scope.colorIndex], scope);
		}
	}

	for (let i = 0; i < barTypes.length; i++) {
		editor.setDecorations(barTypes[i], barRanges[i]);
		editor.setDecorations(topCapTypes[i], topCapRanges[i]);
		editor.setDecorations(bottomCapTypes[i], bottomCapRanges[i]);
	}
}

function visualColumn(doc, lineIndex, tabSize) {
	const line = doc.lineAt(lineIndex),
		charIndex = line.firstNonWhitespaceCharacterIndex,
		text = line.text;

	let column = 0;

	for (let i = 0; i < charIndex; i++) {
		if (text[i] === "\t") {
			column += tabSize - (column % tabSize);
		} else {
			column++;
		}
	}

	return column;
}

function addScopeBar(editor, allScopes, barRanges, topCapRanges, bottomCapRanges, scope) {
	const doc = editor.document;

	const startLine = Math.max(1, scope.startLine),
		endLine = Math.min(scope.endLine, doc.lineCount);

	if (startLine > endLine) {
		return;
	}

	let maxInner = 0;

	for (let line = startLine; line <= endLine; line++) {
		let inner = 0;

		for (const other of allScopes) {
			if (other === scope || other.column !== scope.column) {
				continue;
			}

			if (other.startLine > scope.startLine && other.startLine <= line && other.endLine >= line) {
				inner++;
			}
		}

		if (inner > maxInner) {
			maxInner = inner;
		}
	}

	const offset = scopeBasePx + maxInner * scopeStepPx,
		margin = `0 0 0 calc(${scope.column}ch - ${offset}px)`;

	for (let line = startLine; line <= endLine; line++) {
		barRanges.push({
			range: new vscode.Range(line - 1, 0, line - 1, 0),
			renderOptions: { before: { margin: margin } },
		});
	}

	const capWidth = Math.max(0, offset - lineWidthPx),
		capMargin = `0 0 0 calc(${scope.column}ch - ${offset}px + ${lineWidthPx}px)`,
		capRender = { before: { margin: capMargin, width: `${capWidth}px` } };

	topCapRanges.push({
		range: new vscode.Range(startLine - 1, 0, startLine - 1, 0),
		renderOptions: capRender,
	});

	bottomCapRanges.push({
		range: new vscode.Range(endLine - 1, 0, endLine - 1, 0),
		renderOptions: capRender,
	});
}

function deactivate() {
	isDeactivating = true;

	if (restartTimeout) {
		clearTimeout(restartTimeout);
	}

	if (goDaemon) {
		goDaemon.kill();
	}

	disposeDecorationTypes();

	cachedScopes.clear();
}

module.exports = {
	activate: activate,
	deactivate: deactivate,
};
