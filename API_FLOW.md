# Flujo API: procesamiento asíncrono y progreso real

Este documento define el contrato entre el frontend de EduInclusiva AI, los webhooks de n8n y la tabla `public.jobs` de Supabase. El navegador no debe leer ni escribir directamente en `jobs`: n8n usa una credencial de Supabase con privilegios de servidor y expone solamente los dos webhooks públicos autenticados.

## 1. Crear el trabajo

`src/main.js` hace `POST` a `VITE_WEBHOOK_URL` después de validar y normalizar el texto. El body debe incluir el contenido en ambas claves durante la transición de workflows:

```json
{
  "content": "Texto normalizado del documento",
  "text": "Texto normalizado del documento",
  "profile": "tdah",
  "adaptations": ["tdah"],
  "fileName": "material.pdf",
  "userEmail": "docente@ejemplo.com"
}
```

El primer nodo de n8n debe rechazar una solicitud si `content` y `text` están vacíos. Si ambas existen, usar `content` como fuente canónica y comprobar que coincidan. Tras la validación, n8n inserta un registro en `public.jobs` y devuelve inmediatamente HTTP `202`:

```json
{
  "job_id": "d7d0c419-3d18-461a-9d78-4e0b165cd34a",
  "status": "queued",
  "progress_status": "queued",
  "progress": 5
}
```

Nunca se debe esperar a la IA dentro de este webhook; devolver `202` permite que el frontend active el polling sin agotar la conexión.

## 2. Persistir las etapas en Supabase

Aplicar primero `supabase/migrations/20260819_add_jobs_rag_progress.sql`. El workflow de n8n actualiza `jobs` con una operación `UPDATE ... WHERE id = :job_id` después de cada etapa. Estados recomendados:

| `status` | `progress_status` | `progress` | Acción |
| --- | --- | ---: | --- |
| `queued` | `queued` | 5 | Job creado. |
| `processing` | `extracting` | 20 | Validar y preparar contenido. |
| `processing` | `chunking` | 40 | Generar y guardar `extracted_chunks`. |
| `processing` | `retrieving` | 60 | Consultar el índice/vector store. |
| `processing` | `adapting` | 80 | Generar la adaptación con IA. |
| `completed` | `completed` | 100 | Guardar resultado final. |
| `failed` | `failed` | 100 | Guardar mensaje de error seguro para el usuario. |

`extracted_chunks` debe ser JSONB con objetos serializables; por ejemplo:

```json
[
  { "index": 0, "text": "Primer fragmento…", "char_count": 842 },
  { "index": 1, "text": "Segundo fragmento…", "char_count": 931 }
]
```

Para esta fase, n8n puede llamar a `chunkDocument` durante una futura Edge Function o replicar exactamente su contrato: máximo 1000 caracteres, respetar oraciones y dividir solo una oración que exceda por sí misma el límite.

## 3. Consultar el estado

Mientras el trabajo no termine, `src/main.js` hace `GET` a:

```text
VITE_STATUS_WEBHOOK_URL?job_id=<UUID>
```

El webhook de estado busca el registro por su `id` y devuelve HTTP `200` con este contrato:

```json
{
  "job_id": "d7d0c419-3d18-461a-9d78-4e0b165cd34a",
  "status": "processing",
  "progress_status": "chunking",
  "stage": "chunking",
  "progress": 40,
  "updated_at": "2026-08-19T18:00:00Z"
}
```

`stage` se mantiene temporalmente por compatibilidad con el frontend actual, que usa `stage` para la etiqueta visual. En la siguiente actualización de frontend, debe preferirse `progress_status` y usar `stage` solo como fallback. `progress` es un número entre 0 y 100; aunque no se persiste en la migración mínima, n8n puede derivarlo determinísticamente desde `progress_status` antes de responder.

Al completar, incluir `adapted_text` (o `output`) en la misma respuesta. Al fallar, usar `status: "failed"` y un campo `error` no sensible. Para un UUID inexistente, devolver `404` con `{ "status": "not_found" }`.

## 4. Seguridad y operaciones

- Protegé ambos webhooks con un secreto, JWT o validación de usuario. Las variables `VITE_*` son públicas y no sirven como secreto.
- La credencial de Supabase usada por n8n debe ser de servidor; nunca exponer `service_role` al navegador.
- No devolver `extracted_chunks` completos desde el webhook de estado: pueden ser grandes y contener contenido educativo sensible. Devolver solo progreso, estado, resultado final o un error seguro.
- Registrar `job_id`, etapa y duración en n8n para diagnosticar trabajos detenidos. No registrar el texto completo del documento.
