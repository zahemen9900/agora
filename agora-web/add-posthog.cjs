const { Project, SyntaxKind } = require('ts-morph');
const fs = require('fs');

const project = new Project({
  tsConfigFilePath: './tsconfig.app.json', // or tsconfig.json if app doesn't exist
  skipAddingFilesFromTsConfig: true
});

// Load all tsx files in src/
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
  const fileName = sourceFile.getBaseNameWithoutExtension().toLowerCase();
  let modified = false;
  let needsPostHogImport = false;
  
  const jsxElements = [...sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement), ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)];
  
  for (const element of jsxElements) {
    const opening = element.getKind() === SyntaxKind.JsxElement ? element.getOpeningElement() : element;
    const tagName = opening.getTagNameNode().getText();
    
    if (tagName !== 'Button' && tagName !== 'button') continue;
    
    // Extract text for naming
    let text = '';
    if (element.getKind() === SyntaxKind.JsxElement) {
      // Try to get simple text children
      for (const child of element.getJsxChildren()) {
        if (child.getKind() === SyntaxKind.JsxText) {
          text += child.getText().trim();
        } else if (child.getKind() === SyntaxKind.JsxExpression) {
            // maybe a string literal inside
            const expr = child.getExpression();
            if (expr && (expr.getKind() === SyntaxKind.StringLiteral || expr.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral)) {
                text += expr.getLiteralText();
            }
        }
      }
    }
    
    // If no text, check aria-label or title
    if (!text) {
      const ariaLabel = opening.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.getKind() === SyntaxKind.JsxAttribute) {
          const init = ariaLabel.getInitializer();
          if (init && init.getKind() === SyntaxKind.StringLiteral) text = init.getLiteralText();
      }
      const title = opening.getAttribute('title');
      if (!text && title && title.getKind() === SyntaxKind.JsxAttribute) {
          const init = title.getInitializer();
          if (init && init.getKind() === SyntaxKind.StringLiteral) text = init.getLiteralText();
      }
    }
    
    if (!text) text = 'action';
    
    let actionName = text.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!actionName) actionName = 'clicked';
    if (!actionName.endsWith('clicked') && !actionName.endsWith('opened') && !actionName.endsWith('closed')) {
        actionName += '_clicked';
    }
    
    const eventName = `${fileName}_${actionName}`;
    
    if (tagName === 'Button') {
      if (!opening.getAttribute('trackingEvent')) {
        opening.addAttribute({
          name: 'trackingEvent',
          initializer: `"${eventName}"`
        });
        modified = true;
      }
    } else if (tagName === 'button') {
      // It's a native button
      needsPostHogImport = true;
      
      const onClickAttr = opening.getAttribute('onClick');
      if (onClickAttr && onClickAttr.getKind() === SyntaxKind.JsxAttribute) {
        const init = onClickAttr.getInitializer();
        if (init && init.getKind() === SyntaxKind.JsxExpression) {
            const expr = init.getExpression();
            if (expr) {
                // If it already has posthog.capture, skip
                if (expr.getText().includes('posthog?.capture') || expr.getText().includes('posthog.capture')) {
                    continue;
                }
                const newOnClick = `(e: any) => { posthog?.capture('${eventName}'); const handler = ${expr.getText()}; if (typeof handler === 'function') (handler as any)(e); }`;
                onClickAttr.setInitializer(`{${newOnClick}}`);
                modified = true;
            }
        }
      } else if (!onClickAttr) {
        opening.addAttribute({
          name: 'onClick',
          initializer: `{() => posthog?.capture('${eventName}')}`
        });
        modified = true;
      }
      
      // Now we need to find the enclosing React component to inject `const posthog = usePostHog();`
      let current = element.getParent();
      let componentFunc = null;
      while (current) {
          if (current.getKind() === SyntaxKind.FunctionDeclaration) {
              const name = current.getName();
              if (name && /^[A-Z]|^use/.test(name)) { componentFunc = current; break; }
          } else if (current.getKind() === SyntaxKind.ArrowFunction || current.getKind() === SyntaxKind.FunctionExpression) {
              const p = current.getParent();
              if (p && p.getKind() === SyntaxKind.VariableDeclaration) {
                  const name = p.getName();
                  if (name && /^[A-Z]|^use/.test(name)) { componentFunc = current; break; }
              }
          }
          current = current.getParent();
      }
      
      if (!componentFunc) {
         // fallback to outermost function
         let c = element.getParent();
         while(c) {
             if (c.getKind() === SyntaxKind.FunctionDeclaration || c.getKind() === SyntaxKind.ArrowFunction || c.getKind() === SyntaxKind.FunctionExpression) {
                 componentFunc = c;
             }
             c = c.getParent();
         }
      }

      if (componentFunc) {
          const body = componentFunc.getBody();
          if (body && body.getKind() === SyntaxKind.Block) {
              const statements = body.getStatements();
              const hasPostHog = statements.some(s => s.getText().includes('usePostHog()'));
              if (!hasPostHog) {
                  body.insertStatements(0, 'const posthog = usePostHog();');
              }
          } else if (body && body.getKind() !== SyntaxKind.Block) {
              // We need to convert it to a block. However, ts-morph can't do this easily if it's ParenthesizedExpression,
              // so we will just rewrite the entire function body text safely.
              const bodyText = body.getText();
              // Remove wrapping parens if they exist
              let cleanBody = bodyText;
              if (cleanBody.startsWith('(') && cleanBody.endsWith(')')) cleanBody = cleanBody.slice(1, -1);
              componentFunc.setBodyText(`{ const posthog = usePostHog(); return (${cleanBody}); }`);
          }
      }
    }
  }
  
  if (modified) {
    if (needsPostHogImport) {
        const imports = sourceFile.getImportDeclarations();
        const hasPostHogImport = imports.some(i => i.getModuleSpecifierValue() === '@posthog/react');
        if (!hasPostHogImport) {
            sourceFile.addImportDeclaration({
                namedImports: ['usePostHog'],
                moduleSpecifier: '@posthog/react'
            });
        }
    }
    sourceFile.saveSync();
    updatedCount++;
    console.log(`Updated ${fileName}.tsx`);
  }
}

console.log(`Successfully updated ${updatedCount} files.`);
