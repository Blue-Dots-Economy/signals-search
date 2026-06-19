export type VectorizeField = { path: string; weight: number };
export type ItemSchema = { properties?: Record<string, Record<string, unknown>> };

export function resolveVectorizeFields(schema: ItemSchema): { fields: VectorizeField[] } {
  const props = schema.properties ?? {};
  const fields: VectorizeField[] = [];
  for (const [name, prop] of Object.entries(props)) {
    if (prop.vectorize !== true) continue;
    if (prop.private === true) {
      throw new Error(`property "${name}" is marked private and cannot be vectorized (item_state holds only a mask)`);
    }
    const weight = typeof prop.vector_weight === 'number' && prop.vector_weight > 0 ? prop.vector_weight : 1;
    fields.push({ path: name, weight });
  }
  return { fields };
}
