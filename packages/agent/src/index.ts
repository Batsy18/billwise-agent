export function hello(): string {
  return 'hello from agent';
}

if (require.main === module) {
  console.log(hello());
}
