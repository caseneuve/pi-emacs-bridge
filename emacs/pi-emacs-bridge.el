;;; pi-emacs-bridge.el --- Attach Emacs to running Pi editor sessions -*- lexical-binding: t; -*-

;;; Commentary:

;; Minimal v1 client for extensions/emacs-bridge.ts.

;;; Code:

(require 'cl-lib)
(require 'json)
(require 'subr-x)

(declare-function flycheck-overlay-errors-at "flycheck" (pos))
(declare-function flycheck-error-message "flycheck" (err))
(declare-function flycheck-error-line "flycheck" (err))
(declare-function flycheck-error-filename "flycheck" (err))

(declare-function flymake-diagnostics "flymake" (&optional beg end))
(declare-function flymake-diagnostic-text "flymake" (diag))
(declare-function flymake-diagnostic-beg "flymake" (diag))
(declare-function flymake-diagnostic-buffer "flymake" (diag))

(defgroup pi-emacs-bridge nil
  "Attach Emacs to running Pi editor bridge sessions."
  :group 'tools)

(defcustom pi-emacs-bridge-dir
  (expand-file-name "~/.cache/pi-emacs-bridge/")
  "Directory containing Pi emacs-bridge metadata JSON files."
  :type 'directory)

(defcustom pi-emacs-bridge-timeout 2.0
  "Seconds to wait for bridge responses."
  :type 'number)

(defvar pi-emacs-bridge--process nil)
(defvar pi-emacs-bridge--session nil)
(defvar pi-emacs-bridge--buffer "")
(defvar pi-emacs-bridge--next-id 0)
(defvar pi-emacs-bridge--pending (make-hash-table :test #'equal))

(defun pi-emacs-bridge--json-files ()
  (when (file-directory-p pi-emacs-bridge-dir)
    (directory-files pi-emacs-bridge-dir t "\\.json\\'")))

(defun pi-emacs-bridge--read-metadata-file (file)
  (condition-case _err
      (with-temp-buffer
        (insert-file-contents file)
        (json-parse-buffer :object-type 'alist
                           :array-type 'list
                           :null-object nil
                           :false-object :false))
    (error nil)))

(defun pi-emacs-bridge-list-sessions ()
  "Return a list of discovered Pi bridge sessions (metadata alists)."
  (interactive)
  (let* ((files (pi-emacs-bridge--json-files))
         (sessions
          (cl-remove-if-not
           (lambda (session)
             (let ((proto (alist-get 'protocol session))
                   (socket (alist-get 'socketPath session)))
               (and (stringp proto)
                    (string= proto "pi-emacs-bridge.v1")
                    (stringp socket)
                    (file-exists-p socket))))
           (delq nil (mapcar #'pi-emacs-bridge--read-metadata-file files)))))
    (when (called-interactively-p 'interactive)
      (if sessions
          (message "Found %d bridge session(s)" (length sessions))
        (message "No live bridge sessions found in %s" pi-emacs-bridge-dir)))
    sessions))

(defun pi-emacs-bridge--format-session (session)
  (let* ((sid (alist-get 'sessionId session))
         (session-name (alist-get 'sessionName session))
         (label (alist-get 'label session))
         (pid (alist-get 'pid session))
         (cwd (alist-get 'cwd session))
         (fallback (if (and (stringp cwd) (not (string-empty-p cwd)))
                       (file-name-nondirectory (directory-file-name cwd))
                     (if (stringp sid) (substring sid 0 (min 8 (length sid))) "session")))
         (name (cond
                ((and (stringp session-name) (not (string-empty-p session-name))) session-name)
                ((and (stringp label) (not (string-empty-p label))) label)
                (t fallback))))
    (format "%s | %s | pid=%s | %s"
            name
            (or sid "(no-id)")
            (or pid "?")
            (or cwd "?"))))

(defun pi-emacs-bridge--lookup-session (display sessions)
  (cl-find-if (lambda (s)
                (string= display (pi-emacs-bridge--format-session s)))
              sessions))

(defun pi-emacs-bridge--new-id ()
  (setq pi-emacs-bridge--next-id (1+ pi-emacs-bridge--next-id))
  (format "emacs-%d" pi-emacs-bridge--next-id))

(defun pi-emacs-bridge--disconnect ()
  (when (process-live-p pi-emacs-bridge--process)
    (delete-process pi-emacs-bridge--process))
  (setq pi-emacs-bridge--process nil
        pi-emacs-bridge--session nil
        pi-emacs-bridge--buffer "")
  (clrhash pi-emacs-bridge--pending))

(defun pi-emacs-bridge-detach ()
  "Detach from the currently attached Pi bridge session."
  (interactive)
  (pi-emacs-bridge--disconnect)
  (message "Detached from Pi bridge"))

(defun pi-emacs-bridge--process-filter (_proc chunk)
  (setq pi-emacs-bridge--buffer (concat pi-emacs-bridge--buffer chunk))
  (let* ((parts (split-string pi-emacs-bridge--buffer "\n"))
         (complete (butlast parts))
         (rest (car (last parts))))
    (setq pi-emacs-bridge--buffer (or rest ""))
    (dolist (line complete)
      (let ((trimmed (string-trim line)))
        (when (not (string-empty-p trimmed))
          (condition-case _err
              (let* ((msg (json-parse-string trimmed
                                             :object-type 'alist
                                             :array-type 'list
                                             :null-object nil
                                             :false-object :false))
                     (id (alist-get 'id msg)))
                (when (and id (gethash id pi-emacs-bridge--pending))
                  (puthash id msg pi-emacs-bridge--pending)))
            (error
             (message "pi-emacs-bridge: dropped malformed frame"))))))))

(defun pi-emacs-bridge--process-sentinel (_proc event)
  (unless (string-match-p "open" event)
    (pi-emacs-bridge--disconnect)))

(defun pi-emacs-bridge--ensure-attached ()
  (unless (process-live-p pi-emacs-bridge--process)
    (user-error "Not attached. Run M-x pi-emacs-bridge-attach")))

(defun pi-emacs-bridge--request (method &optional params)
  (pi-emacs-bridge--ensure-attached)
  (let* ((id (pi-emacs-bridge--new-id))
         (payload `((id . ,id)
                    (method . ,method)
                    (params . ,(or params '()))))
         (deadline (+ (float-time) pi-emacs-bridge-timeout))
         (response nil))
    (puthash id :pending pi-emacs-bridge--pending)
    (process-send-string
     pi-emacs-bridge--process
     (concat (json-serialize payload) "\n"))

    (while (and (eq (gethash id pi-emacs-bridge--pending) :pending)
                (< (float-time) deadline))
      (accept-process-output pi-emacs-bridge--process 0.05))

    (setq response (gethash id pi-emacs-bridge--pending))
    (remhash id pi-emacs-bridge--pending)

    (when (eq response :pending)
      (user-error "Bridge timeout waiting for %s" method))

    (let ((ok (alist-get 'ok response)))
      (if ok
          (alist-get 'result response)
        (let ((err (alist-get 'error response)))
          (user-error "Bridge error (%s): %s"
                      (or (alist-get 'code err) "unknown")
                      (or (alist-get 'message err) "unknown")))))))

(defun pi-emacs-bridge-attach ()
  "Attach to a discovered Pi bridge session."
  (interactive)
  (let* ((sessions (pi-emacs-bridge-list-sessions))
         (choices (mapcar #'pi-emacs-bridge--format-session sessions)))
    (unless sessions
      (user-error "No live Pi bridge sessions found"))
    (let* ((choice (completing-read "Attach to Pi session: " choices nil t))
           (session (pi-emacs-bridge--lookup-session choice sessions))
           (socket (alist-get 'socketPath session)))
      (unless session
        (user-error "No session selected"))

      (pi-emacs-bridge--disconnect)

      (setq pi-emacs-bridge--process
            (make-network-process
             :name "pi-emacs-bridge"
             :family 'local
             :service socket
             :coding 'utf-8-unix
             :filter #'pi-emacs-bridge--process-filter
             :sentinel #'pi-emacs-bridge--process-sentinel
             :noquery t))
      (setq pi-emacs-bridge--session session)

      (pi-emacs-bridge--request "ping" nil)
      (message "Attached to %s" (pi-emacs-bridge--format-session session)))))

(defun pi-emacs-bridge--line-at (pos)
  (save-excursion
    (goto-char pos)
    (line-number-at-pos nil t)))

(defun pi-emacs-bridge--location-ref (&optional beg end)
  (let* ((file (or buffer-file-name (buffer-name)))
         (start-pos (or beg (point)))
         (start (pi-emacs-bridge--line-at start-pos))
         (end-pos (when end
                    (if (and (> end start-pos)
                             (save-excursion
                               (goto-char end)
                               (bolp)))
                        (1- end)
                      end)))
         (finish (when end-pos (pi-emacs-bridge--line-at end-pos))))
    (if (and finish (/= finish start))
        (format "%s:%d-%d" file start finish)
      (format "%s:%d" file start))))

(defun pi-emacs-bridge--cursor-payload ()
  `((line . ,(line-number-at-pos nil t))
    (column . ,(current-column))
    (point . ,(point))
    (location . ,(pi-emacs-bridge--location-ref))))

(defun pi-emacs-bridge--source-payload (&optional beg end)
  `((buffer . ,(buffer-name))
    (file . ,(or buffer-file-name ""))
    (location . ,(pi-emacs-bridge--location-ref beg end))))

(defun pi-emacs-bridge--insert (text mode &optional beg end)
  (pi-emacs-bridge--request
   "insert"
   `((text . ,text)
     (mode . ,mode)
     (source . ,(pi-emacs-bridge--source-payload beg end))
     (cursor . ,(pi-emacs-bridge--cursor-payload)))))

(defun pi-emacs-bridge-send-buffer (&optional replace)
  "Send current buffer text to Pi editor.
With prefix arg REPLACE, replace Pi editor text instead of appending."
  (interactive "P")
  (let* ((mode (if replace "replace" "append"))
         (text (buffer-substring-no-properties (point-min) (point-max)))
         (loc (pi-emacs-bridge--location-ref (point-min) (point-max))))
    (pi-emacs-bridge--insert text mode (point-min) (point-max))
    (message "Sent buffer to Pi (%s, %s)" mode loc)))

(defun pi-emacs-bridge-send-region (beg end &optional replace)
  "Send active region BEG..END to Pi editor.
With prefix arg REPLACE, replace Pi editor text instead of appending."
  (interactive "r\nP")
  (unless (use-region-p)
    (user-error "No active region"))
  (let* ((mode (if replace "replace" "append"))
         (text (buffer-substring-no-properties beg end))
         (loc (pi-emacs-bridge--location-ref beg end)))
    (pi-emacs-bridge--insert text mode beg end)
    (message "Sent region to Pi (%s, %s)" mode loc)))

(defun pi-emacs-bridge--send-cursor-position (&optional replace)
  "Helper: send cursor location in format path:line to Pi editor.
With optional REPLACE, replace Pi editor text instead of appending."
  (let* ((mode (if replace "replace" "append"))
         (loc (pi-emacs-bridge--location-ref))
         (text (format "@%s" loc)))
    (pi-emacs-bridge--insert text mode)
    (message "Sent cursor location to Pi (%s)" loc)))

(defun pi-emacs-bridge--send-region-position (beg end &optional replace)
  "Helper: send region location for BEG..END in format path:start-end.
With optional REPLACE, replace Pi editor text instead of appending."
  (let* ((mode (if replace "replace" "append"))
         (loc (pi-emacs-bridge--location-ref beg end))
         (text (format "@%s" loc)))
    (pi-emacs-bridge--insert text mode beg end)
    (message "Sent region location to Pi (%s)" loc)))

(defun pi-emacs-bridge-send-position-dwim (&optional replace)
  "Send location to Pi editor: region range when active, else cursor line.
With prefix arg REPLACE, replace Pi editor text instead of appending."
  (interactive "P")
  (if (use-region-p)
      (pi-emacs-bridge--send-region-position
       (region-beginning)
       (region-end)
       replace)
    (pi-emacs-bridge--send-cursor-position replace)))

(defun pi-emacs-bridge-send-prompt (prompt)
  "Read PROMPT from minibuffer and append it to Pi editor."
  (interactive (list (read-from-minibuffer "Pi prompt: ")))
  (unless (string-match-p "[^[:space:]]" prompt)
    (user-error "Prompt is empty"))
  (pi-emacs-bridge--insert (concat prompt "\n") "append")
  (message "Appended minibuffer prompt to Pi editor"))

(defun pi-emacs-bridge-send-prompt-with-location-dwim (prompt)
  "Read PROMPT and append it with @path:line or @path:start-end.
Uses region location when region is active, otherwise cursor line location."
  (interactive (list (read-from-minibuffer "Pi prompt (+location): ")))
  (unless (string-match-p "[^[:space:]]" prompt)
    (user-error "Prompt is empty"))
  (if (use-region-p)
      (let* ((beg (region-beginning))
             (end (region-end))
             (loc (pi-emacs-bridge--location-ref beg end))
             (text (format "%s\n@%s\n" prompt loc)))
        (pi-emacs-bridge--insert text "append" beg end)
        (message "Appended minibuffer prompt with region location (%s)" loc))
    (let* ((loc (pi-emacs-bridge--location-ref))
           (text (format "%s\n@%s\n" prompt loc)))
      (pi-emacs-bridge--insert text "append")
      (message "Appended minibuffer prompt with cursor location (%s)" loc))))

(defun pi-emacs-bridge--flycheck-errors-at-point ()
  (when (and (featurep 'flycheck) (bound-and-true-p flycheck-mode))
    (let ((errors (flycheck-overlay-errors-at (point))))
      (when errors
        (mapconcat
         (lambda (err)
           (let ((file (or (flycheck-error-filename err) (or buffer-file-name (buffer-name))))
                 (line (or (flycheck-error-line err) (line-number-at-pos)))
                 (msg (or (flycheck-error-message err) "")))
             (format "%s:%s: %s" file line msg)))
         errors
         "\n")))))

(defun pi-emacs-bridge--flymake-errors-at-point ()
  (when (bound-and-true-p flymake-mode)
    (let* ((diags (flymake-diagnostics (point) (point))))
      (when diags
        (mapconcat
         (lambda (diag)
           (let* ((diag-buf (or (flymake-diagnostic-buffer diag) (current-buffer)))
                  (beg (flymake-diagnostic-beg diag))
                  (line (with-current-buffer diag-buf
                          (save-excursion
                            (goto-char beg)
                            (line-number-at-pos))))
                  (msg (or (flymake-diagnostic-text diag) ""))
                  (file (or (buffer-file-name diag-buf)
                            (buffer-name diag-buf))))
             (format "%s:%s: %s" file line msg)))
         diags
         "\n")))))

(defun pi-emacs-bridge--errors-at-point ()
  (or (pi-emacs-bridge--flycheck-errors-at-point)
      (pi-emacs-bridge--flymake-errors-at-point)
      (let ((help (help-at-pt-kbd-string)))
        (when help
          (substring-no-properties help)))))

(defun pi-emacs-bridge-send-error-at-point (&optional replace)
  "Send diagnostic at point to Pi editor with location context.
With prefix arg REPLACE, replace Pi editor text instead of appending."
  (interactive "P")
  (let* ((mode (if replace "replace" "append"))
         (loc (pi-emacs-bridge--location-ref))
         (err (pi-emacs-bridge--errors-at-point)))
    (unless err
      (user-error "No error/diagnostic found at point"))
    (pi-emacs-bridge--insert
     (format "Fix this error at %s:\n%s" loc err)
     mode)
    (message "Sent error at point to Pi (%s, %s)" mode loc)))

(defun pi-emacs-bridge-send-return ()
  "Submit attached Pi editor text (Return convenience)."
  (interactive)
  (let ((result (pi-emacs-bridge--request "send_return" nil)))
    (message "Sent Return to Pi (%s, %s chars)"
             (or (alist-get 'queuedAs result) "turn")
             (or (alist-get 'chars result) 0))))

(defun pi-emacs-bridge-send-escape ()
  "Send Escape semantics to attached Pi session.
Currently this aborts active streaming turn when Pi is busy."
  (interactive)
  (let ((result (pi-emacs-bridge--request "send_escape" nil)))
    (if (alist-get 'aborted result)
        (message "Sent Escape: aborted active Pi turn")
      (message "Sent Escape: Pi already idle"))))

(defun pi-emacs-bridge-clear-editor ()
  "Clear attached Pi editor text (C-c equivalent in Pi editor)."
  (interactive)
  (pi-emacs-bridge--request "clear_editor" nil)
  (message "Cleared Pi editor"))

(defun pi-emacs-bridge-get-state ()
  "Fetch bridge state from attached Pi session."
  (interactive)
  (let ((state (pi-emacs-bridge--request "get_state" nil)))
    (if (called-interactively-p 'interactive)
        (message "%s" state)
      state)))

(define-minor-mode pi-emacs-bridge-mode
  "Minor mode for sending context into running Pi sessions."
  :lighter " PiBridge")

(provide 'pi-emacs-bridge)
;;; pi-emacs-bridge.el ends here
