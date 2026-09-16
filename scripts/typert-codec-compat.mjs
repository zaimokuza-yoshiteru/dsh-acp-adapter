import ts from 'typescript';

// The published alpha.1 generator emits eager codecs. Upstream e459e3263733
// consumes factories instead, without changing the host's package version.
// Emit both accessors for the SAME validator until the supported npm baseline
// moves to the factory generator. This is build-time metadata adaptation only:
// no host patch, weaker validation, or extra runtime dependency. Construction
// remains eager; this does not claim the new generator's lazy-startup benefit.
export function withCodecFactories(source) {
  const file = ts.createSourceFile('typert.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const property = (name) => node.properties.find((p) =>
        ts.isPropertyAssignment(p) && p.name.getText(file) === name);
      const mode = property('mode');
      if (mode && ts.isStringLiteral(mode.initializer) && mode.initializer.text === 'strict') {
        const schema = property('schema');
        // Fail during generation if the pinned generator's contract changes.
        // Re-evaluate/remove this bridge when upgrading it; never guess codecs.
        if (!schema || !ts.isIdentifier(schema.initializer) || property('create')) {
          throw new Error('Unexpected strict Typert codec; review the schema/factory compatibility bridge.');
        }
        edits.push({
          at: schema.getStart(file),
          text: `create: () => ${schema.initializer.text}, `,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (edits.length === 0) throw new Error('No strict Typert codecs found in generated artifact.');
  for (const { at, text } of edits.reverse()) source = source.slice(0, at) + text + source.slice(at);
  return source;
}
