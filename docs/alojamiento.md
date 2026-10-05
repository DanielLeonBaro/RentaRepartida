# Alojamiento de Renta Repartida

El código fuente se puede guardar en GitHub. Los registros de gastos, aportaciones, respaldos y comprobantes de `data/` están excluidos del repositorio. Para conservarlos, respalda esa carpeta por separado.

## GitHub Pages

[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) aloja HTML, CSS y JavaScript estáticos. La aplicación actual utiliza un servidor Node.js para guardar JSON y subir imágenes: publicar únicamente `public/` no conserva esas funciones. No actives Pages para esta versión como si fuera una aplicación completa.

## Cloudflare con la computadora apagada

La opción para que Sofía y Daniel puedan entrar desde distintos dispositivos sin depender de esta computadora es adaptar el servidor a:

- **Workers**, para la página y su API.
- **D1**, para los registros persistentes y las revisiones que evitan conflictos entre dispositivos.
- **R2**, para las imágenes de comprobantes y los respaldos JSON por ciclo.
- **Acceso privado**, para que únicamente ustedes puedan consultar o modificar la información y abrir los comprobantes.

La lógica de cálculo de `lib/domain.mjs` y la interfaz se pueden reutilizar. El guardado de `lib/store.mjs`, las rutas de `server.mjs` y el inicio de sesión necesitan una adaptación: un Worker no conserva la carpeta `data/` de esta computadora como disco remoto.

Actualmente Workers Free incluye 100,000 solicitudes diarias; D1 Free incluye 5 GB de almacenamiento, 5 millones de filas leídas y 100,000 filas escritas por día. R2 Standard incluye 10 GB-mes de almacenamiento, un millón de operaciones de escritura y diez millones de lectura por mes. Las cuotas se comparten con otros proyectos de la misma cuenta. Son cuotas gratuitas, no una promesa de costo cero ilimitado.

R2 requiere activar una suscripción en Cloudflare y cobra el uso que exceda las cuotas incluidas. Mantén Workers y D1 en su plan gratuito y revisa el uso de R2. El subdominio `workers.dev` evita tener que comprar un dominio.

Los registros actuales deben migrarse directamente a la cuenta de Cloudflare después de configurar el acceso privado. No deben subirse a un repositorio público ni incluirse como datos de compilación. La copia local y la copia en la nube serán independientes, salvo que se implemente sincronización expresamente.

Después de adaptar y verificar la versión para Workers, se puede [conectar el repositorio de GitHub a Cloudflare Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) para publicar nuevos cambios con cada push. Conectar el código actual sin esa adaptación no es suficiente.

Fuentes: [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [R2: precios](https://developers.cloudflare.com/r2/pricing/), [R2: activación](https://developers.cloudflare.com/r2/get-started/).

## Cloudflare Tunnel con JSON locales

Otra opción es ejecutar esta versión en la computadora y darle acceso remoto mediante Cloudflare Tunnel. Los datos y las imágenes seguirán en `data/` y la computadora necesitará estar encendida, con la aplicación y el túnel funcionando.

Se debe configurar acceso privado y adaptar la comprobación de origen del servidor antes de exponerlo: actualmente admite únicamente `localhost` y `127.0.0.1`. Un [Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) proporciona una URL temporal y está pensado para pruebas, no para una dirección estable de uso diario.

El túnel no convierte la aplicación en almacenamiento independiente de la computadora, y sus archivos se deben seguir respaldando.
