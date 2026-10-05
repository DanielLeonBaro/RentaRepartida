import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { applyAction, availableMonths, createState, cycleView, today, validateState } from './domain.mjs';

export class Store {
  constructor(directory, date) { this.directory = directory; this.date = date; this.queue = Promise.resolve(); this.warning = ''; }
  async load() {
    await mkdir(this.directory, { recursive: true });
    this.file = path.join(this.directory, 'estado.json');
    this.backup = path.join(this.directory, 'estado.respaldo.json');
    let primaryError;
    try { this.state = validateState(JSON.parse(await readFile(this.file, 'utf8'))); await this.refreshSnapshots(); return this; } catch (error) { primaryError = error; }
    try {
      this.state = validateState(JSON.parse(await readFile(this.backup, 'utf8')));
      this.warning = 'Se cargó el último respaldo correcto porque el archivo principal no pudo leerse. Revisa los datos antes de continuar.';
      await this.refreshSnapshots();
      return this;
    } catch (backupError) {
      if (primaryError.code !== 'ENOENT' || backupError.code !== 'ENOENT') throw new Error('No se pudieron leer los datos ni el respaldo. Los archivos se conservaron; revisa la carpeta data.', { cause: primaryError });
    }
    this.state = createState(this.date);
    await this.atomicWrite(this.file, this.state);
    await this.atomicWrite(this.backup, this.state);
    await this.refreshSnapshots();
    return this;
  }
  async atomicWrite(file, value) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', flush: true }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async refreshSnapshots(date = this.date || today()) {
    try {
      const directory = path.join(this.directory, 'ciclos');
      await mkdir(directory, { recursive: true });
      for (const month of availableMonths(this.state, date)) {
        const snapshot = { schemaVersion: 1, revision: this.state.revision, initialMonth: this.state.initialMonth, cycle: cycleView(this.state, month, date) };
        const file = path.join(directory, `${month}.json`);
        const backup = path.join(directory, `${month}.respaldo.json`);
        let previous;
        try {
          previous = JSON.parse(await readFile(file, 'utf8'));
          if (previous?.schemaVersion !== 1 || previous.cycle?.month !== month) previous = null;
        } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        if (JSON.stringify(previous) === JSON.stringify(snapshot)) continue;
        await this.atomicWrite(backup, previous || snapshot);
        await this.atomicWrite(file, snapshot);
      }
      if (this.warning.startsWith('Tus datos están guardados')) this.warning = '';
    } catch (error) {
      console.error('No se pudo actualizar el respaldo por ciclo:', error.message);
      this.warning = 'Tus datos están guardados en estado.json, pero no se pudo actualizar el respaldo por ciclo. Revisa la carpeta data/ciclos y pulsa Actualizar para reintentarlo.';
    }
  }
  ensureSnapshots(date) {
    const operation = this.queue.then(() => this.refreshSnapshots(date));
    this.queue = operation.catch(() => {});
    return operation;
  }
  update(action, revision, date) {
    const operation = this.queue.then(async () => {
      if (revision !== this.state.revision) { const error = new Error('Los datos cambiaron en otra pestaña. Actualiza los datos y revisa tu cambio antes de guardarlo.'); error.status = 409; throw error; }
      const next = structuredClone(this.state);
      try { applyAction(next, action, date); next.revision++; validateState(next); }
      catch (error) { error.status = 400; throw error; }
      try { await this.atomicWrite(this.backup, this.state); await this.atomicWrite(this.file, next); }
      catch (cause) { throw new Error('No se pudo guardar. Tu cambio sigue en pantalla; revisa que la carpeta data tenga permiso de escritura e inténtalo de nuevo.', { cause }); }
      this.state = next;
      this.warning = '';
      await this.refreshSnapshots(date);
      return next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
