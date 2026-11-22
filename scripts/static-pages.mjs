import { copyFile, mkdir } from 'node:fs/promises'

for (const path of ['connexion', 'messagerie']) {
  const directory = new URL('../dist/' + path + '/', import.meta.url)
  await mkdir(directory, { recursive: true })
  await copyFile(new URL('../dist/index.html', import.meta.url), new URL('index.html', directory))
}
