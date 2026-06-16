// Module augmentation: re-export the Redis class as the default export so that
// `import Redis from 'ioredis'` works as a constructable type in NodeNext mode.
// ioredis 5.x is a CJS package; NodeNext treats the default import as the whole
// module namespace. This shim makes the default import resolve to the Redis class.
declare module 'ioredis' {
  import { Redis as RedisClass } from 'ioredis';
  export default RedisClass;
}
