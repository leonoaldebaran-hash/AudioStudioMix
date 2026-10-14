# Multipista — AudioStudioMix

Gravador multipista simples que roda no navegador. Grave uma pista, depois grave outra **ouvindo as anteriores**, vá empilhando camadas e exporte tudo numa mix em WAV.

## Como usar

1. Abra o site e aperte **●** (ou a tecla `R`). Na primeira vez, o navegador pede permissão para usar o microfone.
2. Com **Contagem** ligada, você ouve 4 cliques e a gravação começa no tempo seguinte.
3. Aperte **●** de novo para parar. A pista aparece na lista.
4. Grave a próxima: as pistas já gravadas tocam enquanto você grava por cima.
5. Ajuste **Vol**, **Pan**, **M** (mudo) e **S** (solo) de cada pista.
6. **Exportar mix** baixa um arquivo `.wav` com tudo junto.

Dicas:
- 🎧 **Use fones de ouvido.** Sem fone, o som das pistas antigas vaza para o microfone.
- Clique na forma de onda para mudar o ponto de início. A gravação começa de onde estiver o cursor.
- **Importar** coloca um arquivo de áudio (um beat, por exemplo) como pista.
- No menu **⋯** de cada pista: deslocar ±10 ms, baixar a pista sozinha ou excluí-la.
- Atalhos: `Espaço` toca/para, `R` grava, `Home` volta ao início.

## Sincronia (latência)

O app compensa sozinho o atraso do áudio. Se a pista nova ficar fora do tempo:
**⚙ Configurações → Compensação de latência**. Se a pista nova estiver **atrasada**, aumente o valor; se estiver **adiantada**, diminua.
Um jeito fácil de calibrar: com o metrônomo ligado, grave palmas no tempo e confira se elas caem nas linhas dos compassos.

Nas configurações você também escolhe a entrada de áudio (por exemplo, uma interface USB) e o canal (entrada 1 ou 2).

## Onde ficam as gravações

Tudo fica salvo **no próprio navegador** (IndexedDB), no aparelho que você usou. Nada é enviado para servidor nenhum. Se limpar os dados do site, as pistas são apagadas, então exporte o que for importante.

## Publicar no GitHub Pages

1. No repositório: **Settings → Pages**.
2. Em *Source*, escolha **Deploy from a branch**, branch `main`, pasta `/ (root)`, e salve.
3. Em 1 ou 2 minutos o site estará em `https://leonoaldebaran-hash.github.io/AudioStudioMix/`.

No celular, abra esse endereço e use "Adicionar à tela inicial" para usar como app.

## Rodar no computador

O microfone só funciona em `https://` ou `localhost`. Dentro da pasta do projeto:

```bash
python3 -m http.server 8000
# abra http://localhost:8000
```

## Como funciona

- HTML/CSS/JS puro, sem build e sem dependências.
- **Web Audio API** para tocar e mixar; um **AudioWorklet** (`recorder-worklet.js`) captura o microfone marcando o instante exato de cada amostra, o que deixa a gravação alinhada com as outras pistas.
- A exportação usa `OfflineAudioContext` e gera WAV 16-bit estéreo.
