import { BOX_COUNT } from '../../shared/minigame.js';
import type { PetView } from '../../shared/types.js';
import { api, ApiError } from '../net/api.js';
import { button, clear, el, modal, toast } from './dom.js';

/**
 * ミニゲーム「どこに かくした？」の画面。
 *
 * プレイテストで、世話と会話しかできず手が余っていたので追加した。
 * 単なるミニゲームにせず、**この子の性格でむずかしさが変わる**のを見せるのが狙い
 * （いたずら好きは入れかえてくる／臆病な子はヒントをくれる）。
 *
 * 大事なのは「目で追える」こと。最初に隠す場所を見せ、
 * 入れ替わる2つの箱が実際に位置を交換するアニメーションを見せないと、
 * ただの3択の運ゲームになってしまう（1周目のプレイテストで実際にそうなっていた）。
 */

export interface MiniGameOptions {
  pet: PetView;
  onFinished(pet: PetView): void;
}

const SWAP_MS = 380;
const PEEK_MS = 1300;

export function openMiniGame(options: MiniGameOptions): void {
  let closed = false;
  // 途中で閉じられたら演出を止める（閉じたあとに DOM を触らないため）。
  const handle = modal(`${options.pet.name} と かくれんぼ`, () => {
    closed = true;
  });
  const info = el('p', { class: 'game-info' }, 'じゅんび中…');
  const statusHost = el('div', { class: 'game-status' });
  const boardHost = el('div', { class: 'game-board' });
  const footHost = el('div', { class: 'game-foot' });
  handle.body.append(info, statusHost, boardHost, footHost);

  let busy = true;

  /**
   * 箱の要素（作り直さずに位置だけ動かすことで、移動が目で追える）。
   * おやつは箱に付いていくので、プレイヤーは箱を追いかける。
   * サーバに送るのは「クリックした位置」であって箱の番号ではない。
   */
  const cups = Array.from({ length: BOX_COUNT }, (_, cupId) => {
    const face = el('span', { class: 'game-box-face' }, '🎁');
    const node = el('button', { class: 'game-box', type: 'button', 'data-cup': String(cupId) }, face);
    node.addEventListener('click', () => {
      if (busy) return;
      void guess(positionOfCup[cupId]);
    });
    return { cupId, node, face };
  });
  for (const cup of cups) boardHost.append(cup.node);

  /** positionOfCup[cupId] = その箱がいまある位置。 */
  let positionOfCup = cups.map((_, index) => index);

  const cupAt = (position: number): number => positionOfCup.indexOf(position);

  function layout(animate: boolean): void {
    for (const cup of cups) {
      cup.node.style.transition = animate ? `transform ${SWAP_MS}ms ease-in-out` : 'none';
      // 位置は CSS グリッドの元の場所からのオフセットで表す。
      const shift = positionOfCup[cup.cupId] - cup.cupId;
      cup.node.style.transform = `translateX(calc(${shift} * (100% + 10px)))`;
    }
  }

  /** 位置を指定して、そこにある箱の顔を変える。 */
  function setFaceAt(position: number, text: string): void {
    cups[cupAt(position)].face.textContent = text;
  }

  function nodeAt(position: number): HTMLElement {
    return cups[cupAt(position)].node;
  }

  function resetFaces(): void {
    for (const cup of cups) {
      cup.face.textContent = '🎁';
      cup.node.classList.remove('game-box-hint', 'game-box-answer', 'game-box-wrong', 'game-box-lift');
    }
  }

  function setStatus(round: number, rounds: number, hits: number): void {
    clear(statusHost);
    statusHost.append(
      el('span', { class: 'chip' }, `${round} / ${rounds} かいめ`),
      el('span', { class: 'chip chip-good' }, `あたり ${hits}`),
    );
  }

  /** 1ラウンドの演出: 隠すところを見せる → 入れ替えを見せる → 当てさせる。 */
  async function playRound(
    startBox: number,
    swaps: Array<[number, number]>,
    hintBox: number | null,
  ): Promise<void> {
    busy = true;
    resetFaces();
    positionOfCup = cups.map((_, index) => index);
    layout(false);

    info.textContent = 'ここに かくしたよ…！ よく 見てて';
    setFaceAt(startBox, '🍪');
    nodeAt(startBox).classList.add('game-box-answer');
    await sleep(PEEK_MS);
    if (closed) return;
    setFaceAt(startBox, '🎁');
    nodeAt(startBox).classList.remove('game-box-answer');

    info.textContent = 'いれかえるよ…';
    for (const [a, b] of swaps) {
      // 位置 a と位置 b にある箱を入れ替える（おやつは箱の中のまま動く）。
      const cupA = cupAt(a);
      const cupB = cupAt(b);
      cups[cupA].node.classList.add('game-box-lift');
      cups[cupB].node.classList.add('game-box-lift');
      positionOfCup[cupA] = b;
      positionOfCup[cupB] = a;
      layout(true);
      await sleep(SWAP_MS + 60);
      if (closed) return;
      cups[cupA].node.classList.remove('game-box-lift');
      cups[cupB].node.classList.remove('game-box-lift');
    }

    if (hintBox !== null) {
      nodeAt(hintBox).classList.add('game-box-hint');
      info.textContent = 'あっ、いま ちらっと 見た…！';
    } else {
      info.textContent = 'どの はこに かくれてる？';
    }
    busy = false;
  }

  /** position はクリックされた位置（箱の番号ではない）。 */
  async function guess(position: number): Promise<void> {
    busy = true;
    try {
      const result = await api.gameGuess(position);
      resetFaces();
      setFaceAt(result.answer, '🍪');
      nodeAt(result.answer).classList.add('game-box-answer');
      if (!result.correct) nodeAt(position).classList.add('game-box-wrong');

      clear(footHost);
      footHost.append(
        el(
          'p',
          { class: `game-result ${result.correct ? 'game-hit' : 'game-miss'}` },
          result.correct ? 'あたり！' : 'はずれ…',
        ),
      );
      await sleep(1400);
      if (closed) return;

      if (result.finished) {
        clear(footHost);
        setStatus(result.rounds, result.rounds, result.hits);
        info.textContent =
          result.hits === result.rounds
            ? 'ぜんぶ あたり！ みごと！'
            : result.hits === 0
              ? 'ぜんぶ はずれ… またこんど！'
              : `${result.hits} / ${result.rounds} あたり！`;
        footHost.append(
          el('p', { class: 'celebrate-reward' }, `🪙 ${result.coins} もらった`),
          button('もういっかい', () => {
            closed = true;
            handle.close();
            openMiniGame({ pet: result.pet, onFinished: options.onFinished });
          }, 'btn btn-primary btn-wide'),
          button('やめる', () => {
            closed = true;
            handle.close();
          }, 'btn btn-ghost btn-wide'),
        );
        options.onFinished(result.pet);
        return;
      }

      setStatus(result.round!, result.rounds, result.hits);
      clear(footHost);
      await playRound(result.startBox ?? 0, result.swaps ?? [], result.hintBox ?? null);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '通信に失敗しました', 'error');
      closed = true;
      handle.close();
    }
  }

  void (async () => {
    try {
      const start = await api.gameStart();
      setStatus(start.round, start.rounds, 0);
      clear(footHost);
      footHost.append(el('p', { class: 'hint' }, `この子の くせ: ${start.behavior}`));
      await playRound(start.startBox, start.swaps, start.hintBox);
      clear(footHost);
    } catch (error) {
      info.textContent = error instanceof ApiError ? error.message : '読み込みに失敗しました';
      busy = true;
    }
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
