import {
  Component,
  EventEmitter,
  Input,
  OnInit,
  Output
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import * as marked from 'marked';
import * as hljs from 'highlight.js';

import {
  ApiResponse,
  Board,
  Column,
  ContextMenuItem,
  Notification,
  Task,
  UserOptions
} from '../../shared/models';
import {
  AuthService,
  ModalService,
  NotificationsService,
  StringsService
} from '../../shared/services';
import { BoardService } from '../board.service';

@Component({
  selector: 'tb-task',
  templateUrl: './task.component.html'
})
export class TaskDisplay implements OnInit {
  private boardsList: Array<Board>;

  private totalTasks: number;
  private completeTasks: number;

  private isOverdue: boolean;
  private isNearlyDue: boolean;

  public strings: any;
  public percentComplete: number;
  public activeBoard: Board;
  public userOptions: UserOptions;
  public contextMenuItems: Array<ContextMenuItem>;

  @Input('task') taskData: Task;
  @Input('add-task') addTask: Function;
  @Input('edit-task') editTask: Function;
  @Input('view-task') viewTask: Function;
  @Input('remove-task') removeTask: Function;
  @Input('collapse') isCollapsed: boolean;

  @Output('on-update-boards') onUpdateBoards: EventEmitter<any>;

  @Input('boards')
  set boards(boards: Array<Board>) {
    this.boardsList = boards;
    this.generateContextMenuItems();
  }

  constructor(private auth: AuthService,
              private sanitizer: DomSanitizer,
              public boardService: BoardService,
              private modal: ModalService,
              private notes: NotificationsService,
              private stringsService: StringsService) {
    this.onUpdateBoards = new EventEmitter<any>();
    this.totalTasks = 0;
    this.completeTasks = 0;
    this.percentComplete = 0;
    this.contextMenuItems = [];

    stringsService.stringsChanged.subscribe(newStrings => {
      this.strings = newStrings;

      if (this.taskData) {
        this.generateContextMenuItems();
      }
    });

    auth.userChanged.subscribe(() => {
      this.userOptions = auth.userOptions;
    });

    boardService.activeBoardChanged.subscribe((board: Board) => {
      this.activeBoard = board;
    });
  }

  ngOnInit() {
    // Since marked is global, the counts need to be stored uniquely per task.
    // String literal access needed because augmenting the type doesn't work.
    marked['taskCounts'] = []; // tslint:disable-line
    if (!this.taskData) {
      return;
    }

    marked['taskCounts'][this.taskData.id] = { // tslint:disable-line
      total: 0,
      complete: 0
    };

    this.generateContextMenuItems();
    this.initMarked();
    this.calcPercentComplete();
    this.checkDueDate();
  }

  getTaskDescription(): string {
    let html = marked(this.taskData.description, this.markedCallback);
    // Escape curly braces for dynamic component.
    html = html.replace(/(\{)([^}]+)(\})/g, '{{ "{" }}$2{{ "}" }}');

    // At least have a space so the compile directive doesn't error
    return html + ' ';
  }

  getPercentStyle() {
    return this.sanitizer.bypassSecurityTrustStyle(
      'padding: 0; height: 5px; background-color: rgba(0, 0, 0, .4); ' +
      'width: ' + (this.percentComplete * 100) + '%;');
  }

  getPercentTitle() {
    return this.strings.boards_task + ' ' +
      (this.percentComplete * 100).toFixed(0) + '% ' +
      this.strings.boards_taskComplete;
  }

  // Expects a color in full HEX with leading #, e.g. #ffffe0
  getTextColor(color: string): string {
    let r = parseInt(color.substr(1, 2), 16),
      g = parseInt(color.substr(3, 2), 16),
      b = parseInt(color.substr(5, 2), 16),
      yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;

    return yiq >= 140 ? '#333333' : '#efefef';
  }

  changeTaskColumn() {
    let select = document.getElementById('columnsList' + this.taskData.id) as HTMLSelectElement,
      id = +select[select.selectedIndex].value;

    if (id === 0) {
      return;
    }

    this.taskData.column_id = id;

    this.boardService.updateTask(this.taskData)
      .subscribe((response: ApiResponse) => {
        response.alerts.forEach(note => this.notes.add(note));

        if (response.status === 'success') {
          this.boardService.updateActiveBoard(response.data[2][0]);
        }
      });
  }

  copyTaskToBoard() {
    let select = document.getElementById('boardsList' + this.taskData.id +
      this.strings.boards_copyTaskTo.split(' ')[0]) as HTMLSelectElement;

    let newBoardId = +select[select.selectedIndex].value;
    let taskData = { ...this.taskData };
    let boardData: Board;

    this.boardsList.forEach(board => {
      if (board.id === newBoardId) {
        taskData.column_id = board.columns[0].id;
        boardData = board;
      }
    });

    this.boardService.addTask(taskData)
      .subscribe((response: ApiResponse) => {
        if (response.status === 'success') {
          this.notes.add(
            new Notification('success',
              this.strings.boards_task +
              ' ' + taskData.title + ' ' +
              this.strings.boards_taskCopied +
              ' ' + boardData.name));
          this.onUpdateBoards.emit();

          return;
        }

        response.alerts.forEach(note => this.notes.add(note));
      });
  }

  moveTaskToBoard() {
    let select = document.getElementById('boardsList' + this.taskData.id +
      this.strings.boards_moveTaskTo.split(' ')[0]) as HTMLSelectElement;

    let newBoardId = +select[select.selectedIndex].value;
    let boardData: Board;

    this.boardsList.forEach(board => {
      if (board.id === newBoardId) {
        this.taskData.column_id = board.columns[0].id;
        boardData = board;
      }
    });

    this.boardService.updateTask(this.taskData)
      .subscribe((response: ApiResponse) => {
        if (response.status === 'success') {
          this.notes.add(
            new Notification('success',
              this.strings.boards_task +
              ' ' + this.taskData.title + ' ' +
              this.strings.boards_taskMoved +
              ' ' + boardData.name));
          this.onUpdateBoards.emit();

          return;
        }

        response.alerts.forEach(note => this.notes.add(note));
      });
  }

  private checkDueDate() {
    if (this.taskData.due_date === '') {
      return;
    }

    let dueDate = new Date(this.taskData.due_date);

    if (isNaN(dueDate.valueOf())) {
      return;
    }

    let millisecondsPerDay = (1000 * 3600 * 24),
      today = new Date(),
      timeDiff = today.getTime() - dueDate.getTime(),
      daysDiff = Math.ceil(timeDiff / millisecondsPerDay);

    if (daysDiff > 0) {
      // past due date
      this.isOverdue = true;
    }

    if (daysDiff <= 0 && daysDiff > -3) {
      this.isNearlyDue = true;
    }
  }

  // Needs anonymous function for proper `this` context.
  private markedCallback = (error: any, text: string) => {
    this.activeBoard.issue_trackers.forEach(tracker => {
      let re = new RegExp(tracker.regex, 'ig');
      let replacements = new Array<any>();
      let result = re.exec(text);

      while (result !== null) {
        let link = '<a href="' +
          tracker.url.replace(/%BUGID%/g, result[1]) +
          '" target="tb_external" rel="noreferrer">' +
          result[0] + '</a>';

        replacements.push({
          str: result[0],
          link
        });
        result = re.exec(text);
      }

      for (let i = replacements.length - 1; i >= 0; --i) {
        text = text.replace(replacements[i].str,
          replacements[i].link);
      }
    });

    return text;
  }

  private getMoveMenuItem() {
    let menuText = this.strings.boards_moveTask +
      ': <select id="columnsList' + this.taskData.id + '" ' +
      '(click)="action($event)">' +
      '<option value="0">' + this.strings.boards_selectColumn + '</option>';

    this.activeBoard.columns.forEach((column: Column) => {
      menuText += '<option value="' + column.id + '">' + column.name + '</option>';
    });

    menuText += '</select>';

    let action = (event: any) => {
      if (event.target.tagName !== 'SELECT') {
        return;
      }

      this.changeTaskColumn();
    };

    return new ContextMenuItem(menuText, action, false, false, true);
  }

  private calcPercentComplete() {
    this.percentComplete = 0;

    // String literal access needed because augmenting the type doesn't work.
    marked['taskCounts'][this.taskData.id] = { // tslint:disable-line
      total: 0,
      complete: 0
    };

    marked(this.taskData.description);

    if (marked['taskCounts'][this.taskData.id].total) { // tslint:disable-line
      this.percentComplete = marked['taskCounts'][this.taskData.id].complete / // tslint:disable-line
        marked['taskCounts'][this.taskData.id].total; // tslint:disable-line
    }
  }

  private generateContextMenuItems() {
    this.contextMenuItems = [
      new ContextMenuItem(this.strings.boards_viewTask, this.viewTask),
      new ContextMenuItem(this.strings.boards_editTask, this.editTask),
      new ContextMenuItem(this.strings.boards_removeTask, this.removeTask),
      new ContextMenuItem('', null, true),
      this.getMoveMenuItem(),
      new ContextMenuItem('', null, true),
      new ContextMenuItem(this.strings.boards_addTask, this.addTask)
    ];

    if (this.boardsList && this.boardsList.length > 1) {
      this.contextMenuItems
        .splice(3, 0,
          new ContextMenuItem('', null, true),
          this.getMenuItem(this.strings.boards_copyTaskTo),
          this.getMenuItem(this.strings.boards_moveTaskTo));
    }
  }

  private getMenuItem(text: string): ContextMenuItem {
    let menuText = text + ': ' +
      '<i class="icon icon-help-circled" ' +
      'data-help="' + this.strings.boards_copyMoveHelp + '"></i> ' +
      '<select id="boardsList' + this.taskData.id + text.split(' ')[0] + '" ' +
      '(click)="action($event)">' +
      '<option value="0">' + this.strings.boards_selectBoard + '</option>';

    this.boardsList.forEach((board: Board) => {
      if (board.name !== this.activeBoard.name) {
        menuText += '<option value="' + board.id + '">' + board.name + '</option>';
      }
    });

    menuText += '</select>';

    let action = (event: any) => {
      if (event.target.tagName !== 'SELECT') {
        return;
      }

      if (text === this.strings.boards_copyTaskTo) {
        this.copyTaskToBoard();
        return;
      }

      this.moveTaskToBoard();
    };

    return new ContextMenuItem(menuText, action, false, false, true);
  }

  private initMarked() {
    let renderer = new marked.Renderer();

    // String literal access needed because augmenting the type doesn't work.
    renderer.listitem = text => {
      if (/^\s*\[[x ]\]\s*/.test(text)) {
        marked['taskCounts'][this.taskData.id].total += 1; // tslint:disable-line

        if (/^\s*\[x\]\s*/.test(text)) {
          marked['taskCounts'][this.taskData.id].complete += 1; // tslint:disable-line
        }

        text = text
          .replace(/^\s*\[ \]\s*/,
            '<i class="icon icon-check-empty"></i> ')
          .replace(/^\s*\[x\]\s*/,
            '<i class="icon icon-check"></i> ');
        return '<li class="checklist">' + text + '</li>';
      } else {
        return '<li>' + text + '</li>';
      }
    };

    renderer.link = (href, title, text) => {
      let out = '<a href="' + href + '"';

      if (title) {
        out += ' title="' + title + '"';
      }

      out += ' target="tb_external" rel="noreferrer">' + text + '</a>';

      return out;
    };

    marked.setOptions({
      renderer,
      smartypants: true,
      highlight: code => {
        return hljs.highlightAuto(code).value;
      }
    });
  }
}

