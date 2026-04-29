const { Project, SyntaxKind } = require('ts-morph');
const fs = require('fs');

const project = new Project({
  tsConfigFilePath: './tsconfig.app.json',
  skipAddingFilesFromTsConfig: true
});

const files = [];
function walk(dir) {
  const list = fs.readdirSync(dir);
  list.forEach(function(file) {
    file = dir + '/' + file;
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      walk(file);
    } else if (file.endsWith('.tsx')) {
      files.push(file);
    }
  });
}
walk('./src');

files.forEach(f => project.addSourceFileAtPath(f));

let updatedCount = 0;

for (const sourceFile of project.getSourceFiles()) {
  let modified = false;
  let needsButtonImport = false;
  
  const jsxElements = [...sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement), ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)];
  
  // We sort in reverse so that replacing nodes doesn't invalidate subsequent nodes
  jsxElements.reverse();
  
  for (const element of jsxElements) {
    const opening = element.getKind() === SyntaxKind.JsxElement ? element.getOpeningElement() : element;
    const tagName = opening.getTagNameNode().getText();
    
    if (tagName !== 'button') continue;
    
    const classNameAttr = opening.getAttribute('className');
    if (!classNameAttr || classNameAttr.getKind() !== SyntaxKind.JsxAttribute) continue;
    
    const init = classNameAttr.getInitializer();
    if (!init || init.getKind() !== SyntaxKind.StringLiteral) continue;
    
    const className = init.getLiteralText();
    let variant = null;
    if (className.includes('btn-primary')) {
        variant = 'primary';
    } else if (className.includes('btn-secondary')) {
        variant = 'secondary';
    }
    
    if (!variant) continue;
    
    // Process onClick to extract trackingEvent and original handler
    let trackingEvent = null;
    let originalHandlerText = null;
    let newOnClickText = null;
    
    const onClickAttr = opening.getAttribute('onClick');
    if (onClickAttr && onClickAttr.getKind() === SyntaxKind.JsxAttribute) {
        const onClickInit = onClickAttr.getInitializer();
        if (onClickInit && onClickInit.getKind() === SyntaxKind.JsxExpression) {
            const expr = onClickInit.getExpression();
            if (expr) {
                const text = expr.getText();
                // Match AST injected posthog
                const match = text.match(/\(e: any\) => \{ posthog\?\.capture\('([^']+)'\); const handler = (.*?); if \(typeof handler === 'function'\) \(handler as any\)\(e\); \}/);
                if (match) {
                    trackingEvent = match[1];
                    originalHandlerText = match[2];
                    newOnClickText = `{${originalHandlerText}}`;
                } else if (text.match(/\(\) => posthog\?\.capture\('([^']+)'\)/)) {
                    const m = text.match(/\(\) => posthog\?\.capture\('([^']+)'\)/);
                    trackingEvent = m[1];
                    newOnClickText = null; // remove onClick entirely if it only had posthog capture
                }
            }
        }
    }
    
    // Now we rewrite the attributes
    // 1. Change tag name
    opening.getTagNameNode().replaceWithText('Button');
    if (element.getKind() === SyntaxKind.JsxElement) {
        element.getClosingElement().getTagNameNode().replaceWithText('Button');
    }
    
    // 2. Remove className btn-primary / btn-secondary and set variant
    let newClassName = className.replace(`btn-${variant}`, '').trim();
    if (newClassName) {
        classNameAttr.setInitializer(`"${newClassName}"`);
    } else {
        classNameAttr.remove();
    }
    
    // 3. Add variant
    opening.addAttribute({ name: 'variant', initializer: `"${variant}"` });
    
    // 4. Update onClick and add trackingEvent
    if (trackingEvent) {
        opening.addAttribute({ name: 'trackingEvent', initializer: `"${trackingEvent}"` });
        if (onClickAttr) {
            if (newOnClickText) {
                onClickAttr.setInitializer(newOnClickText);
            } else {
                onClickAttr.remove();
            }
        }
    }
    
    needsButtonImport = true;
    modified = true;
  }
  
  if (modified) {
    if (needsButtonImport) {
        const imports = sourceFile.getImportDeclarations();
        const hasButtonImport = imports.some(i => i.getModuleSpecifierValue() === '../../components/ui/Button' || i.getModuleSpecifierValue() === '../components/ui/Button' || i.getModuleSpecifierValue().includes('/Button'));
        if (!hasButtonImport) {
            // Determine relative path depth
            const parts = sourceFile.getFilePath().split('/');
            const srcIndex = parts.indexOf('src');
            const depth = parts.length - srcIndex - 2;
            let importPath = '';
            if (depth === 0) importPath = './components/ui/Button';
            else if (depth === 1) importPath = '../components/ui/Button';
            else if (depth === 2) importPath = '../../components/ui/Button';
            else if (depth === 3) importPath = '../../../components/ui/Button';
            
            sourceFile.addImportDeclaration({
                namedImports: ['Button'],
                moduleSpecifier: importPath
            });
        }
    }
    sourceFile.saveSync();
    updatedCount++;
    console.log(`Updated ${sourceFile.getBaseName()}`);
  }
}

console.log(`Successfully updated ${updatedCount} files.`);
