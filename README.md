# Gestão de QR Codes — Cidade Administrativa

Auditoria em campo dos QR Codes de limpeza. Sem banco de dados: tudo fica em arquivos JSON na pasta `data/`.

## Rodar

```sh
npm install
npm run build
npm start          # http://localhost:3000
```

Em desenvolvimento (recarrega sozinho): `npm run dev` → http://localhost:5173

Variáveis opcionais: `PORT` (3000), `HOST` (0.0.0.0), `DATA_DIR` (./data).
Para acessar do celular, use o IP do computador, ex.: `http://192.168.0.10:3000`.

## Onde ficam os dados

| Arquivo | Conteúdo |
| --- | --- |
| `data/qrcodes.json` | Lista base de QR Codes (pode ser editada à mão) |
| `data/status.json` | Conferência: `{ "A1": "ok", "A2": "missing" }` |
| `data/extras.json` | QR Codes cadastrados pelo botão "+ Novo" |
| `data/settings.json` | Filtro de localização da Auditoria |

**Backup = copiar a pasta `data/`.** As gravações são atômicas (arquivo temporário + rename) e
feitas uma de cada vez, então vários celulares podem usar ao mesmo tempo. Se algum arquivo
estiver com JSON quebrado, o servidor recusa gravar em vez de sobrescrever.

## Dados antigos (localStorage)

Na primeira abertura, o app envia ao servidor o que a versão antiga guardava no navegador
(só acrescenta, nunca sobrescreve) e depois limpa o localStorage daquele aparelho.

## Estrutura

```
server/index.mjs   servidor Node sem dependências (API + serve o dist/)
src/App.tsx        interface
src/api.ts         cliente da API
data/              arquivos JSON
```

API: `GET /api/state`, `POST /api/status`, `POST /api/extras`, `PUT /api/settings`, `POST /api/import`.
