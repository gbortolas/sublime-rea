/**
 * Scribe — modelo puro da **Command Palette** (busca fuzzy e execução de comandos).
 *
 * Sem DOM de propósito: a lógica (fuzzy match, navegação, filtragem) vive aqui e é
 * testável; `src/renderer/main.ts` só reflete o estado no DOM.
 *
 * Inspirado no `FindBarModel` (mesmo padrão de modelo puro + binding DOM separável).
 */
import type { Command, CommandListResult } from "../shared";

/** Superfície da ponte consumida pela palette. */
export interface CommandPaletteApi {
  listCommands(): Promise<CommandListResult>;
  executeCommand(commandId: string): Promise<void>;
}

/** Estado observável da palette — o DOM só reflete isto. */
export interface CommandPaletteState {
  readonly visible: boolean;
  readonly query: string;
  readonly commands: readonly Command[];
  readonly selectedIndex: number;
}

/** Notificado a cada mudança de estado (o renderer redesenha o DOM). */
export type CommandPaletteOnChange = (state: CommandPaletteState) => void;
/** Notificado quando um comando é selecionado (o renderer executa). */
export type CommandPaletteOnSelect = (command: Command) => void;

export class CommandPaletteModel {
  private queryValue = "";
  private allCommands: readonly Command[] = [];
  private filteredValue: readonly Command[] = [];
  private selectedIndexValue = 0;
  private visibleFlag = false;
  private loaded = false;

  constructor(
    private readonly api: CommandPaletteApi,
    private readonly onChange?: CommandPaletteOnChange,
    private readonly onSelect?: CommandPaletteOnSelect,
  ) {}

  get isOpen(): boolean {
    return this.visibleFlag;
  }

  state(): CommandPaletteState {
    return {
      visible: this.visibleFlag,
      query: this.queryValue,
      commands: this.filteredValue,
      selectedIndex: this.selectedIndexValue,
    };
  }

  /** Abre a palette, carregando a lista de comandos se necessário. */
  async open(): Promise<void> {
    if (this.visibleFlag) return;
    this.visibleFlag = true;
    this.queryValue = "";
    this.selectedIndexValue = 0;
    if (!this.loaded) {
      try {
        const result = await this.api.listCommands();
        this.allCommands = result.commands;
        this.loaded = true;
      } catch (error) {
        console.error("Scribe: falha ao carregar comandos da palette", error);
        this.allCommands = [];
      }
    }
    this.applyFilter();
    this.emit();
  }

  /** Fecha a palette. Devolve `true` se estava aberta. */
  close(): boolean {
    if (!this.visibleFlag) return false;
    this.visibleFlag = false;
    this.queryValue = "";
    this.selectedIndexValue = 0;
    this.filteredValue = this.allCommands;
    this.emit();
    return true;
  }

  setQuery(value: string): void {
    if (this.queryValue === value) return;
    this.queryValue = value;
    this.selectedIndexValue = 0;
    this.applyFilter();
    this.emit();
  }

  /** Seleciona o próximo item (com wrap). */
  selectNext(): void {
    const count = this.filteredValue.length;
    if (count === 0) return;
    this.selectedIndexValue = (this.selectedIndexValue + 1) % count;
    this.emit();
  }

  /** Seleciona o item anterior (com wrap). */
  selectPrev(): void {
    const count = this.filteredValue.length;
    if (count === 0) return;
    this.selectedIndexValue = (this.selectedIndexValue - 1 + count) % count;
    this.emit();
  }

  /** O comando atualmente selecionado, ou `undefined`. */
  selectedCommand(): Command | undefined {
    return this.filteredValue[this.selectedIndexValue];
  }

  /** Executa o comando atualmente selecionado via callback. */
  executeSelected(): void {
    const command = this.selectedCommand();
    if (command === undefined) return;
    this.onSelect?.(command);
  }

  dispose(): void {
    this.allCommands = [];
    this.filteredValue = [];
    this.loaded = false;
  }

  // ---- interno -------------------------------------------------------------------------------

  /**
   * Fuzzy match SIMPLES (substring case-insensitive por token).
   * O query é splitado por espaços; cada token precisa ser substring do label ou id.
   * Query vazia mostra todos os comandos.
   */
  private applyFilter(): void {
    const q = this.queryValue.trim();
    if (q.length === 0) {
      this.filteredValue = this.allCommands;
      return;
    }
    const tokens = q.split(/\s+/).filter((t) => t.length > 0);
    this.filteredValue = this.allCommands.filter((cmd) => {
      const haystack = `${cmd.label} ${cmd.id} ${cmd.category ?? ""}`.toLowerCase();
      return tokens.every((token) => haystack.includes(token.toLowerCase()));
    });
  }

  private emit(): void {
    this.onChange?.(this.state());
  }
}

// ---------------------------------------------------------------------------------------------
// DOM binding
// ---------------------------------------------------------------------------------------------

export interface CommandPaletteBinding {
  readonly model: CommandPaletteModel;
  dispose(): void;
}

export interface CommandPaletteBindingDeps {
  readonly api: CommandPaletteApi;
  /** Chamado quando um comando é selecionado para execução. */
  readonly onExecute: (command: Command) => void;
}

/**
 * Liga o `CommandPaletteModel` ao DOM. Devolve `undefined` se o markup necessário
 * não existir (degradação explícita, DEC-TR-7).
 */
export function attachCommandPalette(deps: CommandPaletteBindingDeps): CommandPaletteBinding | undefined {
  const paletteEl = document.getElementById("command-palette");
  const input = document.getElementById("palette-input");
  const results = document.getElementById("palette-results");

  if (paletteEl === null || !(input instanceof HTMLInputElement) || results === null) {
    console.info("Scribe: command palette desligada (markup ausente)");
    return undefined;
  }

  const renderState = (state: CommandPaletteState): void => {
    paletteEl.hidden = !state.visible;
    if (!state.visible) return;

    // Sincroniza o input só se o valor do modelo for diferente (evita loop)
    if (input.value !== state.query) {
      input.value = state.query;
    }

    results.innerHTML = "";
    for (let i = 0; i < state.commands.length; i++) {
      const cmd = state.commands[i]!;
      const item = document.createElement("div");
      item.className = `palette-item${i === state.selectedIndex ? " selected" : ""}`;
      item.setAttribute("data-index", String(i));

      const label = document.createElement("span");
      label.className = "cmd-label";
      label.textContent = cmd.label;
      item.appendChild(label);

      if (cmd.accelerator !== undefined) {
        const accel = document.createElement("span");
        accel.className = "cmd-accel";
        accel.textContent = cmd.accelerator;
        item.appendChild(accel);
      }

      if (cmd.category !== undefined) {
        const cat = document.createElement("span");
        cat.className = "cmd-category";
        cat.textContent = cmd.category;
        item.appendChild(cat);
      }

      item.addEventListener("mousedown", (ev: MouseEvent) => {
        ev.preventDefault();
        model.setQuery(model.state().query); // preserva query, não mexe
        const idx = parseInt((ev.currentTarget as HTMLElement).getAttribute("data-index") ?? "0", 10);
        // Navega para o item e executa
        const cmdAt = state.commands[idx];
        if (cmdAt !== undefined) {
          deps.onExecute(cmdAt);
        }
      });

      results.appendChild(item);
    }
  };

  const model = new CommandPaletteModel(
    deps.api,
    renderState,
    deps.onExecute,
  );

  // Eventos do input
  input.addEventListener("input", () => {
    model.setQuery(input.value);
  });

  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      model.close();
      input.blur();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      model.executeSelected();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      model.selectNext();
      // Scroll para manter o selecionado visível
      const sel = results.querySelector(".palette-item.selected");
      if (sel !== null) {
        sel.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      model.selectPrev();
      const sel = results.querySelector(".palette-item.selected");
      if (sel !== null) {
        sel.scrollIntoView({ block: "nearest" });
      }
      return;
    }
  });

  return {
    model,
    dispose: (): void => {
      model.dispose();
    },
  };
}