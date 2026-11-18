export function hello(): string {
  return 'hello from billing-api';
}

if (require.main === module) {
  console.log(hello());
}
