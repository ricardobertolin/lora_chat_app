# Modelos de hardware planejados

Quatro variações sobre a Heltec WiFi LoRa 32 V3, do mais simples ao mais
completo, mais o plano de alcance. Estado atual do projeto: `lora_chat` nas
duas placas, app web por Web Serial/WebUSB (cabo), config de rádio ajustável
em runtime (freq, SF, BW, potência até 22 dBm).

## 1. Modelo de bolso para usar com o celular

**Escopo.** A placa vira um "modem" portátil. Continua usando o app web que já
existe, ligado por um cabo USB-C curto (OTG). A bateria interna serve para a
placa continuar ouvindo o rádio mesmo com o celular desconectado, e para não
drenar o celular. Nenhuma mudança de firmware é necessária para a v1. Uma v2
opcional trocaria o cabo por BLE (Web Bluetooth funciona no Chrome Android, e
resolveria iPhone via app nativo depois, já que iOS não tem Web Serial nem
WebUSB).

**Componentes para comprar:**

- Bateria LiPo 3.7 V de 1000 a 2000 mAh com conector SH1.25-2 (o da Heltec).
  Atenção: a polaridade do conector da Heltec é invertida em relação a muitas
  baterias vendidas prontas, confira antes de plugar
- Cabo USB-C para USB-C curto (10 a 20 cm), de dados, não só carga
- Chave deslizante pequena (tipo SS12D00) para cortar a bateria
- Antena 915 MHz SMA de 5 dBi tipo whip (a stock de ~2 dBi é o gargalo, veja
  a seção de alcance)

**Case 3D:**

- Formato powerbank, uns 80 x 45 x 20 mm
- Janela para o OLED e furo para o botão PRG e o RST
- Furo USB-C na lateral, furo SMA no topo (o pigtail IPEX-SMA da placa
  parafusa direto na parede da case, isso já dá a fixação)
- Compartimento da bateria separado da placa por uma parede fina
- Clipe traseiro ou área plana para velcro, para grudar atrás do celular
- Rasgos de ventilação pequenos perto do regulador

## 2a. Standalone mínimo: localizador na tela da própria placa

**Escopo.** Totalmente autônomo: nada de celular ou desktop, USB só para
flash e carga. Firmware novo e pequeno, sem UI de digitação. Cada placa tem
seu próprio módulo GNSS na serial, transmite sua posição num pacote periódico
(a cada 15 a 60 s) e o OLED mostra o outro equipamento: lat/lon, distância e
rumo calculados das duas posições, idade do último pacote e RSSI. O botão PRG
que já existe na placa alterna as telas (posição, distância, diagnóstico),
então nenhum botão extra é necessário.

Dica de bancada: dá para testar o firmware antes dos módulos chegarem
transmitindo uma posição fixa de mentira em cada placa. O GPS é a última peça
a entrar, não a primeira.

**Componentes para comprar (um kit por placa):**

- Módulo GNSS pequeno: ATGM336H ou u-blox NEO-M8N (UART, 4 fios, 3.3 V)
- Bateria LiPo 1000 mAh com conector SH1.25-2 (mesma nota de polaridade da
  lista 1)
- Chave deslizante
- Antena 915 MHz SMA 5 dBi tipo whip

**Case 3D:**

- Formato chaveiro grande ou "tracker", uns 65 x 40 x 18 mm
- Janela do OLED na frente, furo para o PRG (é o único controle)
- GPS montado no topo da case com a antena cerâmica virada para cima, longe da
  antena LoRa
- SMA no topo, USB-C na lateral para carga e flash
- Alça de cordão

**Nota de firmware.** Definir o pacote de posição já pensando nos outros
modelos: um tipo de mensagem "posição" no mesmo protocolo do chat, em vez de
um formato à parte. Assim o app web pode plotar a posição recebida, o
repetidor repete posição e chat do mesmo jeito, e o standalone completo ganha
a tela de mapa de graça. Esse modelo também é o melhor para levantar o alcance
real: beacon periódico com RSSI na tela, andando por aí.

## 2b. Standalone completo (tudo na placa)

**Escopo.** Firmware novo (pode nascer do `lora_chat`): UI no display, lista
de conversas, digitação por teclado físico I2C, beep ou vibração ao receber. O
OLED 0.96" da placa serve para uma v1 espartana, mas para uso real vale um
display maior. É essencialmente construir um T-Deck caseiro.

**Componentes para comprar:**

- Teclado M5Stack CardKB v1.1 (QWERTY completo por I2C, resolve digitação com
  4 fios) ou teclado BlackBerry Q10 com adaptador I2C se quiser algo mais
  compacto
- Display maior, escolha um: ILI9341 2.4"/2.8" SPI (barato, colorido) ou
  e-paper 2.13" (lê no sol, gasta quase nada)
- Bateria 18650 com suporte, ou LiPo 2000+ mAh com conector SH1.25-2 (mesma
  nota de polaridade)
- Chave liga/desliga
- Buzzer passivo ou motorzinho de vibração (notificação)
- Antena 915 MHz SMA 5 dBi tipo whip

**Case 3D:**

- Formato "comunicador/pager": tela em cima, CardKB embaixo, duas peças com
  encaixe
- Antena SMA saindo pelo topo, nunca para baixo
- Bandeja interna para a 18650 e canaleta para os fios I2C
- Furos para USB-C (carga e flash), chave e buzzer
- Alça de cordão no canto

## 3. Roteador intermediário (repetidor de teste)

**Escopo.** Precisa de uma terceira Heltec V3, essa é a primeira compra.
Firmware repetidor simples: recebe pacote, verifica um ID de mensagem para não
repetir duplicata, decrementa um campo TTL para não criar loop, retransmite
após um atraso aleatório curto. OLED mostra contadores (ouvidos, repetidos,
RSSI). Como as mensagens já são fragmentadas com estrutura, dá para
reaproveitar o formato. Para teste vale um modo "papagaio burro" primeiro
(repete tudo uma vez) e sofisticar depois.

**Componentes para comprar:**

- 3ª Heltec WiFi LoRa 32 V3
- Bateria 18650 (ou duas em paralelo) com suporte
- Painel solar 5 V 1 a 2 W e um módulo de carga (TP4056 com proteção
  alimentando o USB da placa é o arranjo mais simples)
- Antena 915 MHz omnidirecional de 8 a 10 dBi em fibra de vidro (~1 m de
  comprimento, num repetidor fixo a antena boa rende mais que em qualquer
  outro nó) e pigtail SMA curto
- Prensa-cabo PG7 e o-ring ou silicone para vedação
- Abraçadeiras de mastro ou fita de aço

**Case 3D:**

- Caixa vertical estanque estilo "birdhouse": tampa com aba cobrindo as
  juntas, furos só por baixo (dreno e prensa-cabo)
- Imprimir em PETG ou ASA, PLA deforma no sol
- Antena por fora no topo, conector SMA vedado com o-ring
- Painel solar inclinado na face norte, bateria embaixo (peso baixo ajuda no
  mastro)
- Suporte traseiro para abraçadeira de mastro

## Para chegar aos 4 km

Vale para todos os modelos, em ordem de custo-benefício:

1. **Antena e altura primeiro.** A stock de ~2 dBi é o gargalo. Whip de
   5 dBi nos nós portáteis, fibra de vidro de 8 a 10 dBi nos fixos, e antena
   alta com linha de visada o mais limpa possível. Nota: quanto maior o ganho
   de uma omni, mais "achatado" o lobo de radiação, então 10 dBi só vale em
   nó fixo nivelado com o horizonte, num portátil inclinando na mão a 5 dBi
   rende mais. Altura vale mais que potência: 4 km com
   visada é fácil, 400 m através de prédios é difícil.
2. **Parâmetros de rádio.** A config atual já permite: SF10 a SF12, BW
   125 kHz, potência 22 dBm. SF12/125 dá o alcance máximo mas mensagens
   lentas, comece em SF10 e suba se precisar. Confirmar 915 MHz (faixa ANATEL
   no Brasil), as antenas precisam casar com isso.
3. **Ponto fixo direcional.** Se um lado for fixo, uma Yagi 915 MHz de 10 dBi
   apontada dobra o link budget de graça.
4. **O repetidor da lista 3** num ponto alto no meio do caminho resolve o que
   a física não resolver.

## Nota de escopo geral

Os modelos 1, 2a e 2b podem compartilhar o firmware se o standalone for
estruturado como "lora_chat + UI local", mantendo o protocolo de rádio
idêntico. Assim todos os modelos conversam entre si e com o app web sem forks
de protocolo.
