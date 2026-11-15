;;; companion.test.el --- Protocol regressions -*- lexical-binding: t; -*-
(require 'ert)
(load (expand-file-name "../emacs/pi-emacs-bridge.el"
                        (file-name-directory load-file-name)) nil t)

(defun pi-bridge-test-response (frame)
  "Deliver FRAME through the real parser while a request is pending."
  (let ((pi-emacs-bridge--pending (make-hash-table :test #'equal))
        (pi-emacs-bridge--buffer ""))
    (cl-letf (((symbol-function 'pi-emacs-bridge--ensure-attached) #'ignore)
              ((symbol-function 'process-send-string)
               (lambda (_process payload)
                 (let* ((request (json-parse-string payload :object-type 'alist))
                        (id (alist-get 'id request)))
                   (pi-emacs-bridge--process-filter
                    nil (concat (json-serialize `((id . ,id) ,@frame)) "\n"))))))
      (pi-emacs-bridge--request "test"))))

(ert-deftest pi-bridge-propagates-json-false-errors ()
  (let ((err (should-error
              (pi-bridge-test-response
               '((ok . :false)
                 (error . ((code . "empty_editor") (message . "Editor is empty")))))
              :type 'user-error)))
    (should (string-match-p "Bridge error (empty_editor): Editor is empty"
                            (error-message-string err)))))

(ert-deftest pi-bridge-returns-success-result ()
  (should (equal (pi-bridge-test-response '((ok . t) (result . ((pong . t)))))
                 '((pong . t)))))

(ert-deftest pi-bridge-idle-escape-reports-idle ()
  (let (notice)
    (cl-letf (((symbol-function 'pi-emacs-bridge--request)
               (lambda (&rest _) '((aborted . :false))))
              ((symbol-function 'message)
               (lambda (format-string &rest args)
                 (setq notice (apply #'format format-string args)))))
      (pi-emacs-bridge-send-escape))
    (should (equal notice "Sent Escape: Pi already idle"))))

(ert-deftest pi-bridge-parses-fragmented-utf8-frames ()
  (let ((pi-emacs-bridge--pending (make-hash-table :test #'equal))
        (pi-emacs-bridge--buffer ""))
    (puthash "one" :pending pi-emacs-bridge--pending)
    (pi-emacs-bridge--process-filter nil "{\"id\":\"one\",\"ok\":true,\"result\":\"λ")
    (should (eq (gethash "one" pi-emacs-bridge--pending) :pending))
    (pi-emacs-bridge--process-filter nil "\"}\n")
    (should (equal (alist-get 'result (gethash "one" pi-emacs-bridge--pending)) "λ"))))
