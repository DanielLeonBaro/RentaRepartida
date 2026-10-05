# Renta Repartida

Una aplicación local, en español, para apartar entre Sofía y Daniel el dinero de la renta y los gastos. Requiere Node.js 22 o posterior (ya instalado en esta computadora). No necesita instalar paquetes, cuentas ni conexión a internet.

Para consultar opciones de publicación, lee [Alojamiento en GitHub y Cloudflare](docs/alojamiento.md). Esta versión guarda los datos en el disco de la computadora donde corre el servidor.

## Abrir

Haz doble clic en **Iniciar Renta Repartida.cmd**. Se inicia el servidor en segundo plano y se abre **http://127.0.0.1:3210** en tu navegador. Al cerrar el navegador, los datos se conservan. Puedes volver a usar el mismo acceso para abrirla.

También puedes ejecutar `node server.mjs` desde esta carpeta. En este modo, Ctrl+C detiene el servidor. Si utilizas el acceso de Windows, el servidor se detiene al cerrar sesión o reiniciar la computadora.

## Usar

1. Selecciona el mes cuyo vencimiento es el día 15. Su ciclo incluye del 16 anterior al 15 seleccionado.
2. Haz clic en un cobro para ajustar el dinero disponible. Para Sofía también puedes ajustar el ingreso estimado, incluyendo sus comisiones. Daniel mantiene su ingreso de $24,000, pero puede reducir su disponibilidad.
3. Cuando aparten el dinero, usa **Registrar y cerrar**, escribe el importe real y confirma. También puedes cerrar en $0. Para corregir una equivocación, abre la aportación cerrada y pulsa **Reabrir para corregir**. Su importe anterior deja de contar como apartado hasta que vuelvas a cerrarla; se muestra como referencia.
4. Edita o agrega gastos eligiendo explícitamente **Solo este ciclo** o **Este y los siguientes**. Para quitar un gasto, elige su vigencia, pulsa **Quitar gasto** y confirma.
5. Cambia el mes mostrado en el calendario para consultar ambas mitades del ciclo. La lista de abajo siempre muestra todos sus cobros.
6. En cualquier aportación, abierta o cerrada, elige una imagen en **Comprobantes de esta aportación** y pulsa **Guardar imagen**. Acepta PNG, JPG y WebP de hasta 10 MB. Puedes abrir las imágenes guardadas haciendo clic en su miniatura; se conservan al reabrir y corregir la aportación.
7. En **Editar gasto**, asigna una **Fecha de corte / pago**. Si el cambio es permanente, se repite el mismo día cada mes; febrero y los meses cortos usan el último día cuando sea necesario. Una fecha puntual aplica solo al ciclo elegido.
8. En el calendario o en la lista de gastos, pulsa **Pagar** para registrar fecha e importe reales. El importe real reemplaza el presupuesto **solo en ese ciclo** y recalcula las aportaciones pendientes. Puedes corregir el pago o quitar su registro para volver al presupuesto.

El selector empieza en el primer mes de renta, octubre de 2026 para los registros existentes. Muestra los meses transcurridos y el siguiente mes calendario; al comenzar cada mes se agrega otro vencimiento. Los meses anteriores al primer pago no están disponibles. Los cobros de septiembre que financian el primer vencimiento de octubre se conservan.

Las fechas de cada gasto aparecen en el calendario de pagos; la meta para reunir todos los gastos del ciclo sigue siendo el día 15. Registrar que un gasto se pagó no registra una aportación automáticamente: las aportaciones y el pago de los recibos son registros distintos.

Los cobros pasados no se cierran solos. Permanecen incluidos en el reparto hasta que registres su aportación, incluso $0. Un faltante de capacidad o un sobrante se muestra por separado; el sobrante no se transfiere automáticamente a otro ciclo.

El reparto se basa en el dinero **disponible**, no en todo el salario. Si quedan $10,000 de gastos y dos cobros tienen $5,000 y $15,000 disponibles, sus aportaciones serán $2,500 y $7,500. Cada aportación cerrada queda fija y se descuenta antes de repartir lo pendiente.

Los cambios permanentes rigen desde el ciclo seleccionado hasta el siguiente cambio permanente ya programado, si existe. Los ajustes de **Solo este ciclo** en otros meses conservan prioridad sobre los gastos habituales. Los cambios no afectan ciclos anteriores al seleccionado.

## Tus archivos

- `data/estado.json`: todos los registros, ajustes y cierres.
- `data/estado.respaldo.json`: el estado válido anterior al último guardado.
- `data/ciclos/AAAA-MM.json`: resumen completo de ese vencimiento, con gastos efectivos, pagos reales, cobros, aportaciones y referencias a comprobantes.
- `data/ciclos/AAAA-MM.respaldo.json`: la copia anterior del resumen de ese ciclo.
- `data/comprobantes/AAAA-MM/`: las imágenes originales de los comprobantes de ese ciclo.

Para hacer un respaldo externo, copia **toda la carpeta data** con el servidor detenido, incluyendo las imágenes. Para restaurarlo, detén el servidor y reemplaza los archivos y carpetas de `data`. El registro principal sigue siendo `estado.json`; los JSON por ciclo son copias consultables que se actualizan al guardar y al abrir la aplicación. No edites manualmente los archivos mientras la aplicación está abierta. Si el principal está dañado, la aplicación intentará cargar el respaldo y mostrará un aviso; si ambos están dañados, se detendrá sin borrarlos.

Cada guardado comprueba si otra pestaña ha modificado los datos. En caso de conflicto, el formulario permite actualizar sin perder lo escrito y revisar antes de volver a guardar.

La aplicación escucha solo en `127.0.0.1`; no está publicada ni disponible desde otros dispositivos. Todos los importes son pesos mexicanos y las fechas usan Hermosillo.

## Verificar

Ejecuta `node --test`. Las pruebas usan carpetas temporales y no modifican tus registros.

Para verificar las interacciones y el diseño en Chrome o Edge, ejecuta `node scripts/verificar-navegador.mjs`. Usa registros temporales y guarda capturas de escritorio y móvil en `.preview`.
