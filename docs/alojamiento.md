# Alojamiento de Renta Repartida

La aplicación está preparada para **Cloudflare Workers + D1**, con una clave compartida para Sofía y Daniel. Funciona aunque la computadora esté apagada. El código está en GitHub; los registros, las claves y los comprobantes están excluidos del repositorio.

## GitHub Pages

[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) aloja HTML, CSS y JavaScript estáticos. La aplicación actual utiliza un servidor Node.js para guardar JSON y subir imágenes: publicar únicamente `public/` no conserva esas funciones. No actives Pages para esta versión como si fuera una aplicación completa.

## Cloudflare con la computadora apagada

La versión en la nube utiliza:

- **Workers**, para la página y su API.
- **D1**, para los registros persistentes y las revisiones que evitan conflictos entre dispositivos.
- **D1 también para los comprobantes**, comprimidos en el navegador a WebP, con un máximo de 1,600 píxeles por lado y 500 KB. Se guardan como texto base64 en filas separadas, siguiendo el enfoque de Cassian's Log. No requiere R2.
- **Acceso privado**, para que únicamente ustedes puedan consultar o modificar la información y abrir los comprobantes.

La interfaz y `lib/domain.mjs` se comparten con la versión local. `cloud/worker.mjs` sirve la página y la API; `cloud/store.mjs` guarda el estado, su versión anterior y los JSON por ciclo en una transacción de D1. El control de revisiones rechaza los cambios de una pestaña desactualizada sin sobrescribir los datos ni guardar imágenes huérfanas. Los formularios conservan lo escrito si hay un error.

Workers Free incluye 100,000 solicitudes diarias. D1 Free permite 500 MB por base de datos y 5 GB por cuenta, con 5 millones de filas leídas y 100,000 escritas al día. Las cuotas se comparten con otros proyectos de la misma cuenta. Una imagen de 500 KB ocupa alrededor de 667 KB al guardarse en base64; para un uso de dos personas con capturas pequeñas este enfoque resulta suficiente. No son cuotas ilimitadas.

Mantén el plan gratuito de Workers y D1. El subdominio `workers.dev` evita comprar un dominio. La configuración no activa R2 ni contrata un plan de pago.

## Publicar desde Windows

En una terminal, desde esta carpeta:

```powershell
npm ci
npx wrangler login
npm test
npm run cloud:check
npm run cloud:setup
```

`cloud:setup` crea una base llamada `renta-repartida`, escribe su identificador en `wrangler.jsonc`, aplica el esquema y genera una clave aleatoria si todavía no existe. Guarda la clave en el archivo privado **`.deploy/acceso.json`**, la configura como secreto `APP_PASSWORD` y publica el Worker. Luego importa el estado de `data/estado.json` y sus comprobantes directamente a la aplicación protegida. Sin archivos locales, inicia un primer ciclo en el mes actual con los gastos iniciales; no marca aportaciones como pagadas.

La terminal muestra la dirección publicada y la ubicación de la clave; no muestra la clave. Compártanla únicamente entre ustedes. Las sesiones duran siete días y usan cookies firmadas, `HttpOnly`, `Secure` y `SameSite=Strict`. Cambiar el secreto invalida las sesiones anteriores.

La migración valida todas las imágenes locales antes de enviar datos; los originales de hasta 500 KB se conservan sin recomprimir. Si un archivo excede ese tamaño, se detiene con un mensaje y conserva la copia local. Se importan primero las imágenes y finalmente los registros de manera atómica. Si ya hay registros en la nube, la importación se rechaza y no los reemplaza. Para reintentar una importación incompleta:

```powershell
npm run cloud:import
```

La nube y la copia local son **independientes**: después de migrar, usen la dirección de Cloudflare en ambos dispositivos para compartir cambios. Una modificación posterior en `localhost` no se sincroniza con la nube.

## Actualizar desde GitHub

Para publicar cambios de código manualmente:

```powershell
npm ci
npm test
npm run cloud:deploy
```

Esto conserva los registros en D1 y el secreto del Worker. No vuelvas a importar datos para actualizar el diseño o la lógica. Si una actualización añade migraciones, aplica antes `npx wrangler d1 migrations apply DB --remote`.

Las rutas `/`, `/sofia` y `/daniel` comparten el mismo acceso y estado. La actualización que agrega los calendarios personales no requiere una migración SQL: los gastos iniciales se muestran sin modificar sus registros anteriores y se guardan con el primer cambio personal. Si abres un calendario sin sesión, después de ingresar la clave regresas a ese calendario.

Para publicar con cada push, abre el Worker `renta-repartida` en Cloudflare → **Settings → Builds** y [conecta GitHub con Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/) al repositorio `DanielLeonBaro/RentaRepartida`, rama `main`. Directorio raíz: `/`; comando de compilación: `npm run cloud:check`; comando de despliegue: `npx wrangler deploy`. Mantén `APP_PASSWORD` como secreto del Worker; no lo incluyas en GitHub ni en el comando de compilación. Esta conexión requiere autorizar la integración de GitHub en Cloudflare y no se realiza automáticamente con un push.

## Respaldos

Cada guardado conserva el JSON principal anterior y el JSON anterior de cada ciclo en D1. **Respaldar ciclo** descarga un archivo `renta-AAAA-MM.json` con gastos efectivos, pagos, cobros, cierres y referencias a comprobantes. Desde el primer cambio personal también incluye los calendarios de Sofía y Daniel del mes. El JSON no incluye las imágenes: descárgalas desde sus miniaturas para una copia externa completa del ciclo. La API privada `/api/backup?month=AAAA-MM&previous=1` permite descargar la versión anterior del resumen.

Para restaurar **toda** la nube a un momento anterior, D1 Free tiene [Time Travel de siete días](https://developers.cloudflare.com/d1/reference/time-travel/). Puedes exportar la base completa desde D1 para conservar una copia externa con los registros y el contenido de las imágenes. Los resúmenes por ciclo son copias consultables; no sirven para sobrescribir el estado principal directamente.

El JSON principal admite hasta 900 KB para que él y su versión anterior quepan dentro del límite de fila de D1. Las imágenes se guardan por separado y no consumen ese espacio. La versión local sigue usando los archivos y respaldos de `data/` y admite originales de hasta 10 MB.

## Probar Cloudflare sin publicar

```powershell
node scripts/configurar-cloudflare.mjs --local
npm run cloud:dev
```

En otra terminal: `node scripts/migrar-cloudflare.mjs --local`. Abre `http://127.0.0.1:8787` con la clave de `.deploy/acceso.json`. Este entorno usa una base local aislada de la nube y de `data/`; la migración lee la carpeta local sin modificarla.

Fuentes: [precios de Workers](https://developers.cloudflare.com/workers/platform/pricing/), [precios de D1](https://developers.cloudflare.com/d1/platform/pricing/), [límites de D1](https://developers.cloudflare.com/d1/platform/limits/).

## Cloudflare Tunnel con JSON locales

Otra opción es ejecutar esta versión en la computadora y darle acceso remoto mediante Cloudflare Tunnel. Los datos y las imágenes seguirán en `data/` y la computadora necesitará estar encendida, con la aplicación y el túnel funcionando.

Se debe configurar acceso privado y adaptar la comprobación de origen del servidor antes de exponerlo: actualmente admite únicamente `localhost` y `127.0.0.1`. Un [Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) proporciona una URL temporal y está pensado para pruebas, no para una dirección estable de uso diario.

El túnel no convierte la aplicación en almacenamiento independiente de la computadora, y sus archivos se deben seguir respaldando.
