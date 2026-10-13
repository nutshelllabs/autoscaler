moved {
  from = google_pubsub_topic.poller_topic
  to   = google_pubsub_topic.poller_topic[0]
}

moved {
  from = google_pubsub_topic_iam_member.poller_pubsub_sub_iam
  to   = google_pubsub_topic_iam_member.poller_pubsub_sub_iam[0]
}

moved {
  from = google_cloudfunctions2_function.poller_function
  to   = google_cloudfunctions2_function.poller_function[0]
}

moved {
  from = google_cloud_run_service_iam_member.cloud_run_poller_invoker
  to   = google_cloud_run_service_iam_member.cloud_run_poller_invoker[0]
}
