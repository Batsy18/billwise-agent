export function hello(): string {
  return 'hello from mcp-server';
}

if (require.main === module) {
  console.log(hello());
}
